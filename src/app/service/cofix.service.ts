import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BigNumber, Contract, ethers } from 'ethers';
import { PCacheable } from 'ngx-cacheable';
import { Subscription } from 'rxjs';
import { PermissionsQuery } from 'src/app/state/permission/permission.query';
import { PermissionsService } from 'src/app/state/permission/permission.service';
import { TokensInfoQuery } from 'src/app/state/token/token.query';
import { TokenInfoService } from 'src/app/state/token/token.service';
import {
  environment,
  InfuraApiAccessToken,
  infuraNetwork,
} from 'src/environments/environment';

import { IntegrationService } from '../_integration/integration.service';
import {
  BLOCKNUMS_IN_A_DAY,
  ETHER_DECIMALS,
  getContractAddressListByNetwork,
  TOKENS,
} from '../common/constants';
import { ethersOf, unitsOf } from '../common/uitils/bignumber-utils';
import { BalancesQuery } from '../state/balance/balance.query';
import { BalancesService } from '../state/balance/balance.service';
import { MarketDetailsQuery } from '../state/market/market.query';
import { MarketDetailsService } from '../state/market/market.service';
import { SettingsService } from '../state/setting/settings.service';
import {
  getCoFiStakingRewards,
  getCoFiXControllerContract,
  getCoFixFacory,
  getCoFixPair,
  getCofixRouter,
  getCoFiXStakingRewards,
  getCoFiXVaultForLP,
  getCoFiXVaultForTrader,
  getERC20Contract,
  getOracleContract,
} from './confix.abi';
import { EventBusService } from './eventbus.service';
import {
  executionPriceAndAmountOutByERC202ETHThroughUniswap,
  executionPriceAndAmountOutByETH2ERC20ThroughUniswap,
} from './uni-utils';

declare let window: any;

const CACHE_HALF_AN_HOUR = 60 * 1000 * 30;
const CACHE_ONE_MINUTE = 60 * 1000;
const CACHE_TEN_SECONDS = 10 * 1000;
const CACHE_FIVE_SECONDS = 5 * 1000;

const deadline = () => Math.ceil(Date.now() / 1000) + 60 * 10;

const BNJS = require('bignumber.js');

let tokenScriptContent = {};

@Injectable({
  providedIn: 'root',
})
export class CofiXService {
  private provider;
  private currentAccount: string;
  private currentNetwork;
  private contractAddressList: any;

  private integrationSubscription: Subscription;

  constructor(
    private settingsService: SettingsService,
    private eventbusService: EventBusService,
    private tokenInfoService: TokenInfoService,
    private tokenInfoQuery: TokensInfoQuery,
    private permissionsQuery: PermissionsQuery,
    private permissionsService: PermissionsService,
    private balancesService: BalancesService,
    private balancesQuery: BalancesQuery,
    private marketDetailsService: MarketDetailsService,
    private marketDetailsQuery: MarketDetailsQuery,
    private integrationService: IntegrationService,
    private http: HttpClient
  ) {
    BNJS.config({ EXPONENTIAL_AT: 100, ROUNDING_MODE: BNJS.ROUND_DOWN });
    this.reset();
  }

  async isEnabled() {
    if (window.ethereum === undefined) {
      return false;
    } else {
      const provider = new ethers.providers.Web3Provider(window.ethereum);
      return (await provider.listAccounts()).length !== 0;
    }
  }

  async connectSilently() {
    if (await this.isEnabled()) {
      await this.setup(true);
    } else {
      throw new Error('No Account connected to MetaMask.');
    }
  }

  async connectWallet() {
    await this.setup(false);
  }

  private async setup(isEnabled: boolean) {
    if (environment.e2e.on) {
      this.currentAccount = this.getSigner().address;
      this.contractAddressList = getContractAddressListByNetwork(
        this.currentNetwork
      );
      this.trackingBlockchain();
      return;
    }

    if (window.ethereum === undefined) {
      throw new Error('Non-Ethereum browser detected. Install MetaMask.');
    }

    this.provider = new ethers.providers.Web3Provider(window.ethereum);
    if (!isEnabled) {
      this.setCurrentAccount(
        await window.ethereum.request({
          method: 'eth_requestAccounts',
        })
      );
    } else {
      this.currentAccount = (await this.provider.listAccounts())[0];
    }
    this.currentNetwork = (await this.provider.getNetwork()).chainId;
    this.contractAddressList = getContractAddressListByNetwork(
      this.currentNetwork
    );

    this.registerWeb3EventHandler();
    this.trackingBlockchain();
    this.initTokenScript();
  }

  private initTokenScript() {
    this.integrationSubscription = this.integrationService
      .connect()
      .subscribe((val) => {
        tokenScriptContent['CoFi'] = val.CoFi;
        tokenScriptContent['DividendPoolShare'] = val.DividendPoolShare;

        tokenScriptContent[this.contractAddressList.USDT] = {};
        tokenScriptContent[this.contractAddressList.HBTC] = {};

        if (val.LiquidityPoolShare) {
          Object.keys(val.LiquidityPoolShare).forEach((k) => {
            if (val.LiquidityPoolShare[k].pairSymbol === 'USDT') {
              tokenScriptContent[
                this.contractAddressList.USDT
              ].LiquidityPoolShare = val.LiquidityPoolShare[k];
            } else if (val.LiquidityPoolShare[k].pairSymbol === 'HBTC') {
              tokenScriptContent[
                this.contractAddressList.HBTC
              ].LiquidityPoolShare = val.LiquidityPoolShare[k];
            } else {
              console.error(
                `not supporting pairSymbol in LiquidityPoolShare: ${val.LiquidityPoolShare[k].pairSymbol}`
              );
            }
          });
          this.updateMarketDetails();
        }

        if (val.MiningPoolShare) {
          Object.keys(val.MiningPoolShare).forEach((k) => {
            if (val.MiningPoolShare[k].pairSymbol === 'USDT') {
              tokenScriptContent[
                this.contractAddressList.USDT
              ].MiningPoolShare = val.MiningPoolShare[k];
            } else if (val.MiningPoolShare[k].pairSymbol === 'HBTC') {
              tokenScriptContent[
                this.contractAddressList.HBTC
              ].MiningPoolShare = val.MiningPoolShare[k];
            } else {
              console.error(
                `not supporting pairSymbol in MiningPoolShare: ${val.MiningPoolShare[k].pairSymbol}`
              );
            }
          });
        }

        // uncomment this for debugging
        // this.printToken(val);
      });
  }

  private printToken(val) {
    if (val.CoFi) {
      Object.keys(val.CoFi).forEach((k) => {
        console.log(`CoFi instance with ID ${k}:`);
        Object.keys(val.CoFi[k]).forEach((kk) => {
          if (val.CoFi[k][kk] === undefined) {
            console.error(
              `CoFi instance with ID ${k}\n, key ${kk} === undefined`
            );
          } else {
            console.log(
              `CoFi instance with ID ${k}\n, key ${kk} ===${val.CoFi[k][
                kk
              ].toString()}`
            );
          }
        });
      });
    } else {
      console.log('No CoFi token defined');
    }

    if (val.LiquidityPoolShare) {
      Object.keys(val.LiquidityPoolShare).forEach((k) => {
        console.log(`LiquidityPoolShare instance with ID ${k}:`);
        Object.keys(val.LiquidityPoolShare[k]).forEach((kk) => {
          if (val.LiquidityPoolShare[k][kk] === undefined) {
            console.error(
              `LiquidityPoolShare instance with ID ${k}\n, key ${kk} === undefined`
            );
          } else {
            console.log(
              `LiquidityPoolShare instance with ID ${k}\n, key ${kk} ===${val.LiquidityPoolShare[
                k
              ][kk].toString()}`
            );
          }
        });
      });
    } else {
      console.log('No LiquidityPoolShare token defined');
    }

    if (val.MiningPoolShare) {
      Object.keys(val.MiningPoolShare).forEach((k) => {
        console.log(`MiningPoolShare instance with ID ${k}:`);
        Object.keys(val.MiningPoolShare[k]).forEach((kk) => {
          if (val.MiningPoolShare[k][kk] === undefined) {
            console.error(
              `MiningPoolShare instance with ID ${k}\n, key ${kk} === undefined`
            );
          } else {
            console.log(
              `MiningPoolShare instance with ID ${k}\n, key ${kk} ===${val.MiningPoolShare[
                k
              ][kk].toString()}`
            );
          }
        });
      });
    } else {
      console.log('No MiningPoolShare token defined');
    }

    if (val.DividendPoolShare) {
      Object.keys(val.DividendPoolShare).forEach((k) => {
        console.log(`DividendPoolShare instance with ID ${k}:`);
        Object.keys(val.DividendPoolShare[k]).forEach((kk) => {
          if (val.DividendPoolShare[k][kk] === undefined) {
            console.error(
              `DividendPoolShare instance with ID ${k}\n, key ${kk} === undefined`
            );
          } else {
            console.log(
              `DividendPoolShare instance with ID ${k}\n, key ${kk} ===${val.DividendPoolShare[
                k
              ][kk].toString()}`
            );
          }
        });
      });
    } else {
      console.log('No DividendPoolShare token defined');
    }
  }

  private registerWeb3EventHandler() {
    window.ethereum
      .on('disconnect', (error) => {
        this.reset();
        this.eventbusService.emit({ name: 'disconnected_from_blockchain' });
      })
      .on('accountsChanged', (accounts) => {
        this.setCurrentAccount(accounts);
        const currentAccount = this.currentAccount;
        this.eventbusService.emit({
          name: 'accountsChanged',
          value: currentAccount,
        });
      })
      .on('chainChanged', (chainId) => {
        this.currentNetwork = chainId;
        this.contractAddressList = getContractAddressListByNetwork(chainId);
        this.eventbusService.emit({
          name: 'chainChanged',
          value: chainId,
        });
      });
  }

  getCurrentProvider() {
    return this.provider;
  }

  // an infura provider used when wallect is not connected
  // with this provider, pages can get all public information, such as changePrice
  private defaultProvider() {
    return new ethers.providers.InfuraProvider(
      infuraNetwork,
      InfuraApiAccessToken
    );
  }

  getCurrentNetwork() {
    return this.currentNetwork;
  }

  getCurrentAccount() {
    return this.currentAccount;
  }

  getCurrentContractAddressList() {
    return this.contractAddressList;
  }

  @PCacheable({ maxAge: CACHE_TEN_SECONDS })
  async getERC20Allowance(address: string, spender: string) {
    const contract = getERC20Contract(address, this.provider);
    const allowance = await contract.allowance(this.currentAccount, spender);
    return allowance;
  }

  // 获得兑换单价，不考虑冲击成本，
  // undefined 代表 ETH
  // 1 eth -> n erc20 ：changePrice(undefined, toToken)
  // 1 erc20 -> n eth ：changePrice(fromToken, undefined)
  // 1 erc20 -> n erc20 ：changePrice(fromToken, toToken)
  async changePrice(fromToken: string, toToken: string) {
    if (!this.provider) {
      return;
    }

    let result1 = new BNJS(1);
    let result2 = new BNJS(1);
    if (toToken !== undefined) {
      // ETH > ERC20
      // p * (1-k) * (1-theta)
      const kinfo = await this.getKInfo(toToken);
      const price = await this.checkPriceNow(toToken);
      result1 = new BNJS(price.changePrice)
        .times(new BNJS(1).minus(kinfo.k))
        .times(new BNJS(1).minus(kinfo.theta));
    }

    if (fromToken !== undefined) {
      // ERC20 > ETH
      // (1-theta) / (p * (1+k))
      const kinfo = await this.getKInfo(fromToken);
      const price = await this.checkPriceNow(fromToken);
      result2 = new BNJS(1)
        .minus(kinfo.theta)
        .div(new BNJS(price.changePrice).times(new BNJS(1).plus(kinfo.k)));
    }

    const result = result1.times(result2);
    return result.toString();
  }

  // 获得预言机单价，不考虑冲击成本，k 和 theta
  // 参数含义同上
  async nestPrice(fromToken: string, toToken: string) {
    if (!this.provider) {
      return;
    }

    let result1 = new BNJS(1);
    let result2 = new BNJS(1);
    if (toToken !== undefined) {
      const price = await this.checkPriceNow(toToken);
      result1 = new BNJS(price.changePrice);
    }

    if (fromToken !== undefined) {
      const price = await this.checkPriceNow(fromToken);
      result2 = new BNJS(1).div(new BNJS(price.changePrice));
    }
    const result = result1.times(result2);
    return result.toString();
  }

  // 获得兑换的执行价格，考虑冲击成本，amount 为 fromToken 的个数
  async executionPriceAndExpectedCofi(
    fromToken: string,
    toToken: string,
    amount: string
  ) {
    if (!this.provider) {
      return;
    }

    let excutionPrice1 = new BNJS(1);
    const expectedCofi = [];
    let excutionPrice2 = new BNJS(1);

    let innerAmount = amount;

    if (fromToken !== undefined) {
      if (this.isCoFixToken(fromToken)) {
        const result = await this.executionPriceAndExpectedCofiByERC202ETH(
          fromToken,
          innerAmount
        );
        excutionPrice1 = result.excutionPrice;
        expectedCofi.push(result.expectedCofi);
        innerAmount = excutionPrice1.times(amount).toString();
      } else {
        const result = await executionPriceAndAmountOutByERC202ETHThroughUniswap(
          {
            network: this.currentNetwork,
            address: fromToken,
            decimals: Number(await this.getERC20Decimals(fromToken)),
          },
          innerAmount,
          this.provider
        );
        excutionPrice1 = new BNJS(result.excutionPrice);
        innerAmount = result.amountOut;
      }
    }

    if (toToken !== undefined) {
      if (this.isCoFixToken(toToken)) {
        const result = await this.executionPriceAndExpectedCofiByETH2ERC20(
          toToken,
          innerAmount
        );
        excutionPrice2 = result.excutionPrice;
        expectedCofi.push(result.expectedCofi);
        innerAmount = excutionPrice2.times(innerAmount).toString();
      } else {
        const result = await executionPriceAndAmountOutByETH2ERC20ThroughUniswap(
          {
            network: this.currentNetwork,
            address: toToken,
            decimals: Number(await this.getERC20Decimals(toToken)),
          },
          innerAmount,
          this.provider
        );
        excutionPrice2 = result.excutionPrice;
        innerAmount = result.amountOut;
      }
    }

    const excutionPrice = excutionPrice1.times(excutionPrice2).toString();
    const amountOut = innerAmount;

    return {
      excutionPrice,
      amountOut,
      expectedCofi,
    };
  }

  private async executionPriceAndExpectedCofiByETH2ERC20(
    token: string,
    amount: string
  ) {
    const kinfo = await this.getKInfo(token);
    const price = await this.checkPriceNow(token);
    const valx = new BNJS(amount);
    const fee = this.parseEthers(valx.times(kinfo.theta).toString());

    let c;
    if (valx.lt(500)) {
      c = 0;
    } else if (valx.gte(500) && valx.lte(999000)) {
      c = new BNJS(-1.171e-4).plus(new BNJS(8.386e-7).times(amount));
    } else {
      c = new BNJS(-1.171e-4).plus(new BNJS(8.386e-7).times(999000));
    }

    const excutionPrice = new BNJS(price.changePrice)
      .times(new BNJS(1).minus(new BNJS(kinfo.k).plus(c)))
      .times(new BNJS(1).minus(kinfo.theta));

    return {
      excutionPrice,
      expectedCofi: this.expectedCoFi(token, price, kinfo, fee, true),
    };
  }

  private async executionPriceAndExpectedCofiByERC202ETH(
    token: string,
    amount: string
  ) {
    const kinfo = await this.getKInfo(token);
    const price = await this.checkPriceNow(token);
    const valx = new BNJS(amount).div(new BNJS(price.changePrice));

    const fee = this.parseEthers(valx.times(kinfo.theta).toString());

    let c;
    if (valx.lt(500)) {
      c = 0;
    } else if (valx.gte(500) && valx.lte(999000)) {
      c = new BNJS(2.57e-5).plus(new BNJS(8.542e-7).times(valx));
    } else {
      c = new BNJS(2.57e-5).plus(new BNJS(8.542e-7).times(999000));
    }

    const excutionPrice = new BNJS(1)
      .minus(kinfo.theta)
      .div(
        new BNJS(price.changePrice).times(
          new BNJS(1).plus(new BNJS(kinfo.k).plus(c))
        )
      );

    return {
      excutionPrice,
      expectedCofi: this.expectedCoFi(token, price, kinfo, fee, false),
    };
  }

  // 预计出矿量
  // 注意：交易方向决定传入合约的值，eth2ERC20 决定
  // true：eth -> erc20
  // false: erc20 -> eth
  private async expectedCoFi(
    token: string,
    checkedPriceNow: any,
    kinfo: any,
    fee: BigNumber,
    eth2ERC20: boolean = true
  ) {
    if (!this.isCoFixToken(token)) {
      return;
    }

    const pairAddress = await this.getPairAddressByToken(token);
    const balanceOfPair = await this.getERC20BalanceOfPair(token, token);
    const tokens = this.parseEthers(
      new BNJS(balanceOfPair).div(checkedPriceNow.changePrice).toFixed(8)
    );
    const weth9Balance = this.parseEthers(
      await this.getERC20BalanceOfPair(token, this.contractAddressList.WETH9)
    );
    const navPerShare = this.parseEthers(await this.getNavPerShare(token));
    let x;
    let y;
    if (eth2ERC20) {
      x = weth9Balance;
      y = tokens;
    } else {
      x = tokens;
      y = weth9Balance;
    }
    const trader = getCoFiXVaultForTrader(
      this.contractAddressList.CoFiXVaultForTrader,
      this.provider
    );
    const actualMiningAmountAndDensity = await trader.actualMiningAmountAndDensity(
      pairAddress,
      fee,
      x,
      y,
      navPerShare
    );
    const value = new BNJS(ethersOf(actualMiningAmountAndDensity.amount)).times(
      0.8
    );
    return value;
  }

  // 增加流动性预计得到的 XToken，交易池为：ETH/ERC20。
  async expectedXToken(
    address: string,
    ethAmount: string,
    erc20Amount: string
  ) {
    const kinfo = await this.getKInfo(address);
    const checkedPriceNow = await this.checkPriceNow(address);
    const oraclePrice = [
      this.parseEthers(checkedPriceNow.ethAmount),
      this.parseUnits(
        checkedPriceNow.erc20Amount,
        await this.getERC20Decimals(address)
      ),
      '0',
      kinfo.kOriginal.toString(),
      '0',
    ];
    const pair = getCoFixPair(
      await this.getPairAddressByToken(address),
      this.provider
    );
    const navPerShareForMint = new BNJS(
      ethersOf(await pair.getNAVPerShareForMint(oraclePrice))
    );
    const recentCheckedPrice = await this.checkPriceNow(address);
    const expectedShareByEthAmount = new BNJS(ethAmount).div(
      navPerShareForMint
    );
    const expectedShareByErc20Amount = new BNJS(erc20Amount)
      .div(
        new BNJS(recentCheckedPrice.changePrice).div(new BNJS(1).plus(kinfo.k))
      )
      .div(navPerShareForMint);
    const expectedShare = expectedShareByEthAmount.plus(
      expectedShareByErc20Amount
    );

    return expectedShare.toString();
  }

  // 计算 getETHAmountForRemoveLiquidity 和 getTokenAmountForRemoveLiquidity 所需参数。
  // removeERC20 = false，对应 getETHAmountForRemoveLiquidity
  // removeERC20 = true，对应 getTokenAmountForRemoveLiquidity
  // 返回：kinfo、checkedPriceNow、nAVPerShareForBurn、两个冲击成本
  async calculateArgumentsUsedByGetAmountRemoveLiquidity(
    token: string,
    pair: string,
    amount: string,
    removeERC20: boolean = false
  ) {
    const kinfo = await this.getKInfo(token);
    const checkedPriceNow = await this.checkPriceNow(token);
    const coFiXPair = getCoFixPair(pair, this.provider);
    const navPerShare = await this.getNavPerShare(token);

    const tradingVolumeInETH = new BNJS(amount).times(navPerShare);

    const k = new BNJS(kinfo.k);
    let cB;
    let cS = 0;
    if (tradingVolumeInETH.lt(500)) {
      cB = cS = 0;
    } else {
      cB = new BNJS(0.0000257).plus(
        new BNJS(0.0000008542).times(tradingVolumeInETH)
      );
      if (removeERC20) {
        cS = new BNJS(-0.0001171).plus(
          new BNJS(0.0000008386).times(tradingVolumeInETH)
        );
      }
    }

    const oraclePrice = [
      this.parseEthers(checkedPriceNow.ethAmount),
      this.parseUnits(
        checkedPriceNow.erc20Amount,
        await this.getERC20Decimals(token)
      ),
      '0',
      this.parseUnits(k.plus(cB).toString(), 8),
      '0',
    ];
    const nAVPerShareForBurn = ethersOf(
      await coFiXPair.getNAVPerShareForBurn(oraclePrice)
    );

    return { kinfo, checkedPriceNow, nAVPerShareForBurn, cB, cS };
  }

  async getETHAmountForRemoveLiquidity(
    token: string,
    pair: string,
    amount: string
  ) {
    const args = await this.calculateArgumentsUsedByGetAmountRemoveLiquidity(
      token,
      pair,
      amount,
      false
    );

    const result = new BNJS(amount)
      .times(args.nAVPerShareForBurn)
      .times(new BNJS(1).minus(args.kinfo.theta))
      .toString();

    return { nAVPerShareForBurn: args.nAVPerShareForBurn, result };
  }

  async getTokenAmountForRemoveLiquidity(
    token: string,
    pair: string,
    amount: string
  ) {
    const args = await this.calculateArgumentsUsedByGetAmountRemoveLiquidity(
      token,
      pair,
      amount,
      true
    );

    const result = new BNJS(amount)
      .times(args.nAVPerShareForBurn)
      .times(args.checkedPriceNow.changePrice)
      .times(new BNJS(1).minus(new BNJS(args.kinfo.k).plus(args.cS)))
      .times(new BNJS(1).minus(args.kinfo.theta))
      .toString();

    return { nAVPerShareForBurn: args.nAVPerShareForBurn, result };
  }

  unitsOf(amount: BigNumber, decimals: BigNumber) {
    return Number.parseFloat(ethers.utils.formatUnits(amount, decimals));
  }

  ethersOf(amount: BigNumber) {
    return Number.parseFloat(ethers.utils.formatEther(amount));
  }

  private reset() {
    tokenScriptContent = {};
    this.integrationSubscription?.unsubscribe();
    this.untrackingBlockchain();
    this.provider = this.defaultProvider();
    this.currentAccount = undefined;
    this.currentNetwork = environment.network;
    this.contractAddressList = getContractAddressListByNetwork(
      this.currentNetwork
    );
  }

  // 判断是否提供过流动性
  @PCacheable({ maxAge: CACHE_ONE_MINUTE })
  async pairAttended(token: string) {
    const pair = await this.getPairAddressByToken(token);
    const xtBalance = await this.getERC20Balance(pair);
    if (!new BNJS(xtBalance).isZero()) {
      return true;
    }

    const stakingPool = await this.getStakingPoolAddressByToken(token);
    const stakingBalance = await this.getERC20Balance(stakingPool);
    return !new BNJS(stakingBalance).isZero();
  }

  private setCurrentAccount(accounts) {
    if (accounts.length === 0) {
      this.settingsService.reset();
      this.reset();
      this.eventbusService.emit({ name: 'disconnected_from_metamask' });
    } else if (accounts[0] !== this.currentAccount) {
      this.currentAccount = accounts[0];
    }
  }

  // 领取 ETH 收益
  async withdrawEarnedETH() {
    const contract = getCoFiStakingRewards(
      this.contractAddressList.CoFiStakingRewards,
      this.provider
    );
    return await this.executeContractMethodWithEstimatedGas(
      contract,
      'getReward',
      [{}]
    );
  }

  // 领取 CoFi 收益
  async withdrawEarnedCoFi(
    stakingPoolAddress: string,
    staking: boolean = false
  ) {
    const contract = getCoFiXStakingRewards(stakingPoolAddress, this.provider);
    if (staking) {
      return await this.executeContractMethodWithEstimatedGas(
        contract,
        'getRewardAndStake',
        [{}]
      );
    } else {
      return await this.executeContractMethodWithEstimatedGas(
        contract,
        'getReward',
        [{}]
      );
    }
  }

  async withdrawDepositedCoFi(amount: string) {
    const contract = getCoFiStakingRewards(
      this.contractAddressList.CoFiStakingRewards,
      this.provider
    );
    return await this.withdraw(contract, amount);
  }

  async depositCoFi(amount: string) {
    const contract = getCoFiStakingRewards(
      this.contractAddressList.CoFiStakingRewards,
      this.provider
    );
    return this.deposit(contract, this.contractAddressList.CoFiToken, amount);
  }

  async withdrawDepositedXToken(stakingPoolAddress: string, amount: string) {
    const contract = getCoFiXStakingRewards(stakingPoolAddress, this.provider);
    return await this.withdraw(contract, amount);
  }

  async depositXToken(
    stakingPoolAddress: string,
    pairAddress: string,
    amount: string
  ) {
    const contract = getCoFiXStakingRewards(stakingPoolAddress, this.provider);
    return this.deposit(contract, pairAddress, amount);
  }

  private async withdraw(contract: Contract, amount: string) {
    const balance = await contract.balanceOf(this.currentAccount);
    const value = this.parseEthers(amount);
    if (balance.lt(value)) {
      throw new Error('Insufficient Balance.');
    } else {
      return await this.executeContractMethodWithEstimatedGas(
        contract,
        'withdraw',
        [value, {}]
      );
    }
  }

  private async deposit(contract: Contract, token: string, amount: string) {
    const allowance = await this.getERC20Allowance(token, contract.address);
    const balance = await this.getERC20Balance(token);
    const value = this.parseEthers(amount);
    if (allowance.lt(value)) {
      throw new Error('Insufficient Allowance.');
    } else if (new BNJS(balance).lt(amount)) {
      throw new Error('Insufficient Balance.');
    } else {
      return await this.executeContractMethodWithEstimatedGas(
        contract,
        'stake',
        [value, {}]
      );
    }
  }

  private parseUnits(amount: string, unit: number) {
    const bnAmount = new BNJS(amount);
    try {
      return ethers.utils.parseUnits(bnAmount.toFixed(unit), unit);
    } catch (e) {
      return BigNumber.from(bnAmount.times(Math.pow(10, unit)).toFixed(0));
    }
  }

  parseEthers(amount: string) {
    return this.parseUnits(amount, ETHER_DECIMALS);
  }

  // 注意：
  // 传入 eth 是因为 value = eth + fee，从合约中无法直接得出 eth 值
  // amountOutMin ，仅用于判断是可以继续，但实际传入合约的为基于 changePrice 计算出的值，
  // 由于从 ui 传入的 amountOutMin 也是基于 changePrice 算出来的，故差别不大
  async swapExactETHForTokens(
    pair: string,
    token: string,
    amountIn: string,
    amountOutMin: string,
    swapPrice: string,
    fee: string,
    DEX_TYPE: number[]
  ) {
    const ethBalanceOfAccount = new BNJS(await this.getETHBalance());
    const bnValue = new BNJS(amountIn).plus(fee);
    if (bnValue.gt(ethBalanceOfAccount)) {
      throw new Error('Insufficient ETH balance.');
    }

    const erc20Decimals = await this.getERC20Decimals(token);
    if (this.isCoFixToken(token)) {
      const erc20Contract = getERC20Contract(token, this.provider);
      const erc20BalanceOfPair = new BNJS(
        unitsOf(await erc20Contract.balanceOf(pair), erc20Decimals)
      );
      if (new BNJS(amountOutMin).gt(erc20BalanceOfPair)) {
        throw new Error('Insufficient tokens for swapping.');
      }
    }

    const cofixRouter = getCofixRouter(
      this.contractAddressList.CofixRouter,
      this.provider
    );
    return this.executeContractMethodWithEstimatedGas(
      cofixRouter,
      'hybridSwapExactETHForTokens',
      [
        this.parseEthers(amountIn),
        this.parseUnits(
          new BNJS(amountIn).times(swapPrice).times(0.99).toString(),
          erc20Decimals
        ),
        [this.contractAddressList.WETH9, token],
        DEX_TYPE,
        this.currentAccount,
        deadline(),
        {
          value: this.parseEthers(bnValue.toString()),
        },
      ]
    );
  }

  // 传入 token 数量
  async swapExactTokensForETH(
    pair: string,
    token: string,
    amountIn: string,
    amountOutMin: string,
    swapPrice: string,
    fee: string,
    DEX_TYPE: number[]
  ) {
    const erc20Decimals = await this.getERC20Decimals(token);
    const erc20BalanceOfAccount = await this.getERC20Balance(token);

    if (new BNJS(amountIn).gt(erc20BalanceOfAccount)) {
      throw new Error('Insufficient token balance.');
    }

    if (this.isCoFixToken(token)) {
      const wethContract = getERC20Contract(
        this.contractAddressList.WETH9,
        this.provider
      );
      const wethBalanceOfPair = ethersOf(await wethContract.balanceOf(pair));
      if (new BNJS(amountOutMin).gt(wethBalanceOfPair)) {
        throw new Error('Insufficient eth for swapping.');
      }
    }
    const cofixRouter = getCofixRouter(
      this.contractAddressList.CofixRouter,
      this.provider
    );
    return this.executeContractMethodWithEstimatedGas(
      cofixRouter,
      'hybridSwapExactTokensForETH',
      [
        this.parseUnits(amountIn, erc20Decimals),
        this.parseEthers(
          new BNJS(amountIn).times(swapPrice).times(0.99).toString()
        ),
        [token, this.contractAddressList.WETH9],
        DEX_TYPE,
        this.currentAccount,
        deadline(),
        {
          value: this.parseEthers(fee),
        },
      ]
    );
  }

  // ERC20 -> ERC20 = ERC20 -> ETH -> ERC20
  // 故需先用 tokenIn 算出需要的 weth，并进行判断
  async swapExactTokensForTokens(
    pairIn: string,
    tokenIn: string,
    pairOut: string,
    tokenOut: string,
    amountIn: string,
    amountOutMin: string,
    swapPrice: string,
    fee: string,
    DEX_TYPE: number[]
  ) {
    if (
      !(await this.hasEnoughTokenBalance(
        this.currentAccount,
        tokenIn,
        amountIn
      ))
    ) {
      throw new Error('Insufficient token balance.');
    }
    if (this.isCoFixToken(tokenIn) && this.isCoFixToken(tokenOut)) {
      if (
        !(await this.hasEnoughTokenBalance(pairOut, tokenOut, amountOutMin))
      ) {
        throw new Error('Insufficient token for swapping.');
      }
      const kinfo = await this.getKInfo(tokenIn);
      const price = await this.checkPriceNow(tokenIn);
      const wethAmount = new BNJS(amountIn).div(
        new BNJS(price.changePrice)
          .times(new BNJS(1).plus(kinfo.k))
          .times(new BNJS(1).minus(kinfo.theta))
      );
      if (
        !(await this.hasEnoughTokenBalance(
          pairIn,
          this.contractAddressList.WETH9,
          wethAmount.toString()
        ))
      ) {
        throw new Error('Insufficient weth for swapping.');
      }
    }

    const cofixRouter = getCofixRouter(
      this.contractAddressList.CofixRouter,
      this.provider
    );
    return this.executeContractMethodWithEstimatedGas(
      cofixRouter,
      'hybridSwapExactTokensForTokens',
      [
        this.parseUnits(amountIn, await this.getERC20Decimals(tokenIn)),
        this.parseUnits(
          new BNJS(amountIn)
            .times(swapPrice)
            .times(0.99)
            .times(0.99)
            .toString(),
          await this.getERC20Decimals(tokenOut)
        ),
        [tokenIn, this.contractAddressList.WETH9, tokenOut],
        DEX_TYPE,
        this.currentAccount,
        deadline(),
        {
          value: this.parseEthers(fee),
        },
      ]
    );
  }

  async hasEnoughTokenBalance(address: string, token: string, amount: string) {
    const contract = getERC20Contract(token, this.provider);
    const decimals = await this.getERC20Decimals(token);
    const balance = new BNJS(
      unitsOf(await contract.balanceOf(address), decimals)
    );
    return balance.gte(amount);
  }

  async hasEnoughETHBalance(amount: string) {
    const balance = new BNJS(await this.getETHBalance());
    return balance.gt(amount);
  }

  async hasEnoughAllowance(spender: string, token: string, amount: string) {
    const contract = getERC20Contract(token, this.provider);
    const decimals = await this.getERC20Decimals(token);
    const allowance = new BNJS(
      unitsOf(await contract.allowance(this.currentAccount, spender), decimals)
    );
    return allowance.gt(amount);
  }

  async addLiquidity(
    token: string,
    amountETH: string,
    amountToken: string,
    liquidityMin: string,
    fee: string,
    staking: boolean = false
  ) {
    const bnAmountETH = new BNJS(amountETH);
    const bnAmountToken = new BNJS(amountToken);
    if (bnAmountETH.isZero() && bnAmountToken.isZero()) {
      return;
    }

    if (bnAmountETH.gt(0) && !(await this.hasEnoughETHBalance(amountETH))) {
      throw new Error('Insufficient ETH balance.');
    }

    if (
      bnAmountToken.gt(0) &&
      !(await this.hasEnoughTokenBalance(
        this.currentAccount,
        token,
        amountToken
      ))
    ) {
      throw new Error('Insufficient token balance.');
    }

    if (
      bnAmountToken.gt(0) &&
      !(await this.hasEnoughAllowance(
        this.contractAddressList.CofixRouter,
        token,
        amountToken
      ))
    ) {
      throw new Error('Insufficient allowance for this token.');
    }

    const decimals = await this.getERC20Decimals(token);
    const cofixRouter = getCofixRouter(
      this.contractAddressList.CofixRouter,
      this.provider
    );
    if (staking) {
      return await this.executeContractMethodWithEstimatedGas(
        cofixRouter,
        'addLiquidityAndStake',
        [
          token,
          this.parseEthers(amountETH),
          this.parseUnits(amountToken, decimals),
          this.parseEthers(new BNJS(liquidityMin).times(0.99).toString()),
          this.currentAccount,
          deadline(),
          {
            value: this.parseEthers(new BNJS(amountETH).plus(fee).toString()),
          },
        ]
      );
    } else {
      return await this.executeContractMethodWithEstimatedGas(
        cofixRouter,
        'addLiquidity',
        [
          token,
          this.parseEthers(amountETH),
          this.parseUnits(amountToken, decimals),
          this.parseEthers(new BNJS(liquidityMin).times(0.99).toString()),
          this.currentAccount,
          deadline(),
          {
            value: this.parseEthers(new BNJS(amountETH).plus(fee).toString()),
          },
        ]
      );
    }
  }

  async removeLiquidityGetETH(
    pair: string,
    token: string,
    liquidityMin: string,
    amountETHMin: string,
    fee: string
  ) {
    if (
      !(await this.hasEnoughTokenBalance(
        this.currentAccount,
        pair,
        liquidityMin
      ))
    ) {
      throw new Error('Insufficient liquidity tokens.');
    }

    if (
      !(await this.hasEnoughTokenBalance(
        pair,
        this.contractAddressList.WETH9,
        amountETHMin
      ))
    ) {
      throw new Error('Insufficient WETH9 tokens.');
    }

    const cofixRouter = getCofixRouter(
      this.contractAddressList.CofixRouter,
      this.provider
    );
    return await this.executeContractMethodWithEstimatedGas(
      cofixRouter,
      'removeLiquidityGetETH',
      [
        token,
        this.parseEthers(liquidityMin),
        this.parseEthers(new BNJS(amountETHMin).times(0.99).toString()),
        this.currentAccount,
        deadline(),
        {
          value: this.parseEthers(fee),
        },
      ]
    );
  }

  async removeLiquidityGetToken(
    pair: string,
    token: string,
    liquidityMin: string,
    amountTokenMin: string,
    fee: string
  ) {
    if (
      !(await this.hasEnoughTokenBalance(
        this.currentAccount,
        pair,
        liquidityMin
      ))
    ) {
      throw new Error('Insufficient liquidity tokens.');
    }

    if (!(await this.hasEnoughTokenBalance(pair, token, amountTokenMin))) {
      throw new Error('Insufficient token balance.');
    }

    const decimals = await this.getERC20Decimals(token);
    const cofixRouter = getCofixRouter(
      this.contractAddressList.CofixRouter,
      this.provider
    );

    return await this.executeContractMethodWithEstimatedGas(
      cofixRouter,
      'removeLiquidityGetToken',
      [
        token,
        this.parseEthers(liquidityMin),
        this.parseUnits(
          new BNJS(amountTokenMin).times(0.99).toString(),
          decimals
        ),
        this.currentAccount,
        deadline(),
        {
          value: this.parseEthers(fee),
        },
      ]
    );
  }

  // for written contract methods only
  private async executeContractMethodWithEstimatedGas(
    contract: Contract,
    functionName: string,
    args: any
  ) {
    const estimatedGas = new BNJS(
      ethersOf(
        await contract.estimateGas[functionName](...args)
          .then((value) => {
            const minimumGas = BigNumber.from('300000');
            if (value.lt(minimumGas)) {
              return minimumGas;
            }
            return value;
          })
          .catch((err) => {
            return BigNumber.from('700000');
          })
      )
    );
    const argsForOverridden = args.pop();
    argsForOverridden.gasLimit = this.parseEthers(
      estimatedGas.times(1.2).toString()
    );
    args.push(argsForOverridden);
    return contract.connect(this.getSigner())[functionName](...args);
  }

  private getSigner() {
    if (environment.e2e.on) {
      const pk = environment.e2e.wallet;
      return new ethers.Wallet(pk, this.provider);
    }

    return this.provider.getSigner();
  }

  // pair 由 token 决定，targetToken 用来看 pair 对于这个 token 的余额。
  // 对于 ETH，targetToken 用 WETH9 替代
  @PCacheable({ maxAge: CACHE_FIVE_SECONDS })
  async getERC20BalanceOfPair(token: string, targetToken: string) {
    const pair = await this.getPairAddressByToken(token);
    const erc20Contract = getERC20Contract(targetToken, this.provider);
    const amount = new BNJS(
      unitsOf(
        await erc20Contract.balanceOf(pair),
        await this.getERC20Decimals(targetToken)
      )
    ).toString();

    return amount;
  }

  @PCacheable({ maxAge: CACHE_FIVE_SECONDS })
  async currentGasFee() {
    const price = await this.http
      .get('https://ethgasstation.info/json/ethgasAPI.json')
      .toPromise<any>();

    return new BNJS(700000)
      .times(new BNJS(price.fastest).div(10))
      .div(1000000000)
      .toString();
  }

  @PCacheable({ maxAge: CACHE_HALF_AN_HOUR })
  async currentCoFiPrice() {
    const price = await this.http
      .get(
        'https://api.coingecko.com/api/v3/simple/price?ids=cofix&vs_currencies=usd'
      )
      .toPromise<any>();

    return price.cofix.usd;
  }

  // --------- TokenInfo Methods ------------ //

  async getERC20Decimals(tokenAddress: string) {
    const decimals = this.tokenInfoQuery.getDecimals(tokenAddress);
    if (!decimals) {
      const contract = getERC20Contract(tokenAddress, this.provider);
      let result;
      try {
        result = await contract.decimals();
      } catch (e) {
        // 某些合约有 balanceOf 但没有 decimals 方法，这些合约实际不属于 erc20
        // 但目前采用此权宜之计，未来改进
        result = '18';
      }
      this.tokenInfoService.updateTokenInfo(tokenAddress, {
        decimals: result,
      });
      return this.tokenInfoQuery.getDecimals(tokenAddress);
    }
    return decimals;
  }

  async getPairAddressByToken(tokenAddress: string) {
    const pairAddress = this.tokenInfoQuery.getPairAddress(tokenAddress);
    if (!pairAddress) {
      const factory = getCoFixFacory(
        this.contractAddressList.CofixFactory,
        this.provider
      );
      this.tokenInfoService.updateTokenInfo(tokenAddress, {
        pairAddress: await factory.getPair(tokenAddress),
      });
      return this.tokenInfoQuery.getPairAddress(tokenAddress);
    }
    return pairAddress;
  }

  async getStakingPoolAddressByToken(tokenAddress: string) {
    const stakingPoolAddress = this.tokenInfoQuery.getStakingPoolAddress(
      tokenAddress
    );
    if (!stakingPoolAddress) {
      const coFiXVaultForLP = getCoFiXVaultForLP(
        this.contractAddressList.CoFiXVaultForLP,
        this.provider
      );

      const pairAddress = await this.getPairAddressByToken(tokenAddress);
      if (pairAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error('invalid invocation!!!!!');
      }

      this.tokenInfoService.updateTokenInfo(tokenAddress, {
        stakingPoolAddress: await coFiXVaultForLP.stakingPoolForPair(
          await this.getPairAddressByToken(tokenAddress)
        ),
      });
      return this.tokenInfoQuery.getStakingPoolAddress(tokenAddress);
    }
    return stakingPoolAddress;
  }

  // --------- Permissions Methods ------------ //

  // token、spender 对应
  // 交易、资金池页面（增加）：普通token，CofixRouter
  // 资金池（移除）：pair, CofixRouter
  // CoFi：pair，stakingPool
  // 收益：CoFiToken，CoFiStakingRewards
  async approved(token: string, spender: string) {
    const result = this.permissionsQuery.approved(
      this.currentAccount,
      token,
      spender
    );

    // result === false has two possibilities:
    // 1. a new browser which has not approved histories of current account.
    // 2. never got approved
    if (!result) {
      const allowance = await this.getERC20Allowance(token, spender);
      if (!allowance.isZero()) {
        this.permissionsService.updatePermission(
          this.currentAccount,
          token,
          spender
        );
        return true;
      } else {
        return false;
      }
    }

    return result;
  }

  // 目前设计为先授权一个极大值，未来再改进
  // token，spender 见上
  async approve(token: string, spender: string) {
    const contract = getERC20Contract(token, this.provider);
    return await contract
      .connect(this.getSigner())
      .approve(spender, BigNumber.from('999999999999999999999999999999999999'));
  }

  // --------- Tracking Balances  ------------ //

  private getBalancesByAccount(account: string) {
    return this.balancesQuery.getBalancesByAccount(account);
  }

  private getCurrentBalances() {
    return this.getBalancesByAccount(this.currentAccount);
  }

  private async trackingBlockchain() {
    if (this.provider) {
      if (this.currentAccount) {
        await this.updateETHBalance();
        await this.updateDividend();
        this.provider.on('block', async (blockNum) => {
          console.log('updating ...');

          await this.updateETHBalance();
          await this.updateDividend();
          this.updateERC20Balances();
          this.updateUnclaimedCofis();
          this.updateMarketDetails();
        });
      } else {
        this.provider.on('block', async (blockNum) => {
          console.log('updating ...');

          this.updateMarketDetails();
        });
      }
    }
  }

  private untrackingBlockchain() {
    if (this.provider) {
      this.provider.off('block');
    }
  }

  private async updateETHBalance() {
    this.balancesService.updateEthBalance(
      this.currentAccount,
      ethersOf(await this.provider.getBalance(this.currentAccount))
    );
  }

  private async updateDividend() {
    this.balancesService.updateDividend(
      this.currentAccount,
      ethersOf(
        await getCoFiStakingRewards(
          this.contractAddressList.CoFiStakingRewards,
          this.provider
        ).earned(this.currentAccount)
      )
    );
  }

  private async updateUnclaimedCofi(address: string) {
    const coFiXStakingRewards = getCoFiXStakingRewards(
      await this.getStakingPoolAddressByToken(address),
      this.provider
    );
    const earned = ethersOf(
      await coFiXStakingRewards.earned(this.currentAccount)
    );

    const unclaimedCoFi = {};
    unclaimedCoFi[address] = earned;
    this.balancesService.updateUnclaimedCoFi(
      this.currentAccount,
      unclaimedCoFi
    );
  }

  private updateUnclaimedCofis() {
    if (this.getCurrentBalances()?.unclaimedCoFis) {
      Object.keys(this.getCurrentBalances().unclaimedCoFis).forEach(
        async (address) => await this.updateUnclaimedCofi(address)
      );
    }
  }

  private async updateERC20Balance(address: string) {
    const contract = getERC20Contract(address, this.provider);
    const balance = await contract.balanceOf(this.currentAccount);
    let decimals = this.tokenInfoQuery.getDecimals(address);
    if (!decimals) {
      try {
        decimals = await contract.decimals();
      } catch (e) {
        // 某些合约有 balanceOf 但没有 decimals 方法，这些合约实际不属于 erc20
        // 但目前采用此权宜之计，未来改进
        decimals = '18';
      }
    }
    const erc20Balance = {};
    erc20Balance[address] = unitsOf(balance, decimals);
    this.balancesService.updateERC20Balance(this.currentAccount, erc20Balance);
  }

  private updateERC20Balances() {
    if (this.getCurrentBalances()?.erc20Balances) {
      Object.keys(this.getCurrentBalances().erc20Balances).forEach(
        async (address) => await this.updateERC20Balance(address)
      );
    }
  }

  async getETHBalance() {
    const balance = this.getCurrentBalances()?.ethBalance;
    if (!balance) {
      await this.updateETHBalance();
      return this.getCurrentBalances().ethBalance;
    }
    return balance;
  }

  // 普通 ERC20 Token
  // 可存入 Cofi：CoFiToken
  // 已存入 Cofi：CoFiStakingRewards
  // 未参与挖矿 XT：当前资金池的 pair 地址，this.getPairAddressByToken(token)
  // 参与挖矿的 XT：当前资金池对应的 stakingPool 地址，this.getStakingPoolAddressByToken(pair)
  async getERC20Balance(address: string) {
    const balance = this.getCurrentBalances()?.erc20Balances?.[address];
    if (!balance) {
      await this.updateERC20Balance(address);
      return this.getCurrentBalances().erc20Balances[address];
    }
    return balance;
  }

  async earnedCofiAndRewardRate(address: string) {
    let earned = '0';
    if (this.currentAccount) {
      earned = this.getCurrentBalances()?.unclaimedCoFis?.[address];
      if (!earned) {
        await this.updateUnclaimedCofi(address);
        earned = this.getCurrentBalances().unclaimedCoFis[address];
      }
    }

    let rewardRate = await this.getRewardRate(address);
    if (!rewardRate) {
      await this.updateRewardRate(address);
      rewardRate = await this.getRewardRate(address);
    }

    return { earned, rewardRate };
  }

  async earnedETH() {
    const dividend = this.getCurrentBalances()?.dividend;
    if (!dividend) {
      await this.updateDividend();
      return this.getCurrentBalances().dividend;
    }
    return dividend;
  }

  private updateMarketDetails() {
    Object.keys(this.marketDetailsQuery.getValue()).forEach(async (address) => {
      if (!this.isCoFixToken(address)) {
        return;
      }

      await this.updateKInfo(address);
      await this.updateCheckedPriceNow(address);
      await this.updateNAVPerShare(address);
      await this.updateRewardRate(address);
    });
  }

  private async updateKInfo(address: string) {
    let kinfo;

    if (tokenScriptContent[address]?.LiquidityPoolShare?.kInfoK) {
      kinfo = [0, 0, 0];
      kinfo[0] = tokenScriptContent[address].LiquidityPoolShare.kInfoK;
      kinfo[2] = tokenScriptContent[address].LiquidityPoolShare.kInfoTheta;
    } else {
      kinfo = await getCoFiXControllerContract(
        this.contractAddressList.CofiXController,
        this.provider
      ).getKInfo(address);
    }

    this.marketDetailsService.updateMarketDetails(address, {
      kinfo: {
        kOriginal: kinfo[0],
        k: new BNJS(kinfo[0]).div(1e8),
        theta: new BNJS(kinfo[2]).div(1e8),
      },
    });
  }

  private async getKInfo(address: string) {
    let kinfo = this.marketDetailsQuery.getKInfo(address);
    if (!kinfo) {
      await this.updateKInfo(address);
      kinfo = this.marketDetailsQuery.getKInfo(address);
    }
    return kinfo;
  }

  private async updateCheckedPriceNow(tokenAddress: string) {
    let price;

    if (
      tokenScriptContent[tokenAddress]?.LiquidityPoolShare
        ?.referenceExchangeRateEthAmount
    ) {
      price = [0, 0];
      price[0] =
        tokenScriptContent[
          tokenAddress
        ].LiquidityPoolShare.referenceExchangeRateEthAmount;
      price[1] =
        tokenScriptContent[
          tokenAddress
        ].LiquidityPoolShare.referenceExchangeRateErc20Amount;
    } else {
      const oracle = getOracleContract(
        this.contractAddressList.OracleMock,
        this.provider
      );

      price = await oracle.checkPriceNow(tokenAddress);
    }

    const decimals = await this.getERC20Decimals(tokenAddress);
    const ethAmount = ethersOf(price[0]);
    const erc20Amount = unitsOf(price[1], decimals);
    const changePrice = new BNJS(erc20Amount).div(new BNJS(ethAmount));

    this.marketDetailsService.updateMarketDetails(tokenAddress, {
      checkedPriceNow: {
        ethAmount,
        erc20Amount,
        changePrice,
      },
    });
  }

  private async checkPriceNow(address: string) {
    let checkedPriceNow = this.marketDetailsQuery.getCheckedPriceNow(address);
    if (!checkedPriceNow) {
      await this.updateCheckedPriceNow(address);
      checkedPriceNow = this.marketDetailsQuery.getCheckedPriceNow(address);
    }

    return checkedPriceNow;
  }

  private async updateNAVPerShare(address: string) {
    let navPerShare;
    if (tokenScriptContent[address]?.LiquidityPoolShare?.navPerShare) {
      navPerShare = ethersOf(
        tokenScriptContent[address]?.LiquidityPoolShare?.navPerShare
      );
    } else {
      const checkedPriceNow = await this.checkPriceNow(address);
      const pairAddress = await this.getPairAddressByToken(address);

      if (pairAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error('invalid invocation!!!!!');
      }
      const coFiXPair = getCoFixPair(pairAddress, this.provider);
      navPerShare = ethersOf(
        await coFiXPair.getNAVPerShare(
          this.parseEthers(checkedPriceNow.ethAmount),
          this.parseUnits(
            checkedPriceNow.erc20Amount,
            await this.getERC20Decimals(address)
          )
        )
      );
    }

    this.marketDetailsService.updateMarketDetails(address, {
      navPerShare,
    });
  }

  private async getNavPerShare(address: string) {
    const navPerShare = this.marketDetailsQuery.getNavPerShare(address);
    if (!navPerShare) {
      await this.updateNAVPerShare(address);
      return this.marketDetailsQuery.getNavPerShare(address);
    }
    return navPerShare;
  }

  private async updateRewardRate(address: string) {
    let miningRate;
    if (tokenScriptContent[address]?.MiningPoolShare?.cofiMiningRate) {
      miningRate = tokenScriptContent[address].MiningPoolShare.cofiMiningRate;
    } else {
      const coFiXStakingRewards = getCoFiXStakingRewards(
        await this.getStakingPoolAddressByToken(address),
        this.provider
      );
      miningRate = await coFiXStakingRewards.rewardRate();
    }

    const rewardRate = new BNJS(ethersOf(miningRate))
      .times(BLOCKNUMS_IN_A_DAY)
      .toString();
    this.marketDetailsService.updateMarketDetails(address, { rewardRate });
  }

  private async getRewardRate(address: string) {
    const rewardRate = this.marketDetailsQuery.getRewardRate(address);
    if (!rewardRate) {
      await this.updateRewardRate(address);
      return this.marketDetailsQuery.getRewardRate(address);
    }
    return rewardRate;
  }

  async totalETHFromSwapFees() {
    const cofiStakingRewards = getCoFiStakingRewards(
      this.contractAddressList.CoFiStakingRewards,
      this.provider
    );

    return new BNJS(ethersOf(await cofiStakingRewards.pendingSavingAmount()))
      .times(100)
      .div(80)
      .toString();
  }

  async totalETHInDividendPool() {
    const wethContract = getERC20Contract(
      this.contractAddressList.WETH9,
      this.provider
    );
    const ethOfDividendPool = ethersOf(
      await wethContract.balanceOf(this.contractAddressList.CoFiStakingRewards)
    );

    const cofiStakingRewards = getCoFiStakingRewards(
      this.contractAddressList.CoFiStakingRewards,
      this.provider
    );
    const pendingSavingAmount = ethersOf(
      await cofiStakingRewards.pendingSavingAmount()
    );

    return new BNJS(ethOfDividendPool).minus(pendingSavingAmount).toString();
  }

  async shareInDividendPool() {
    const balance = await this.getERC20Balance(
      this.contractAddressList.CoFiStakingRewards
    );

    const cofiStakingRewards = getCoFiStakingRewards(
      this.contractAddressList.CoFiStakingRewards,
      this.provider
    );
    const totalSupply = ethersOf(await cofiStakingRewards.totalSupply());
    const result = new BNJS(balance).div(totalSupply).times(100).toString();

    return result;
  }

  getETHTotalClaimed() {
    if (tokenScriptContent['DividendPoolShare']?.ethTotalClaimed) {
      return ethersOf(tokenScriptContent['DividendPoolShare'].ethTotalClaimed);
    }
  }

  isCoFixToken(token: string): boolean {
    return (
      token === this.contractAddressList.USDT ||
      token === this.contractAddressList.HBTC
    );
  }

  // 参数token 为该token对应的地址
  async loadToken(token: string) {
    try {
      const contract = getERC20Contract(token, this.provider);
      const existToken = this.getExistToken(token);

      if (!existToken) {
        let newToken = await contract.symbol();
        if (!newToken) {
          newToken = `Unknown Token${this.getUnknownTokenIndex()}`;
        }
        TOKENS.push(newToken);
        this.contractAddressList[newToken] = token;
        return newToken;
      } else {
        return existToken;
      }
    } catch (e) {
      console.error(e);
      return undefined;
    }
  }

  getUnknownTokenIndex() {
    return TOKENS.filter((el) => el.indexOf('Unknown') > -1).length + 1;
  }

  getExistToken(address: string) {
    let result;
    Object.keys(this.contractAddressList).forEach((key) => {
      result = this.contractAddressList[key] === address ? key : undefined;
    });
    return result;
  }
}
