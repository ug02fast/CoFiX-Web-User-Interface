import { Component, Inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Platform } from '@ionic/angular';
import { TranslateService } from '@ngx-translate/core';

import { DB_VERSION } from './common/constants';
import { CofiXService } from './service/cofix.service';
import { MetadataQuery } from './state/metadata/metadata.query';
import { MetadataService } from './state/metadata/metadata.service';
import { SettingsQuery } from './state/setting/settings.query';

type State = { lang: string };

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
})
export class AppComponent implements OnInit {
  public selectedIndex = 0;
  public appPages = [
    {
      title: 'Inbox',
      url: '/folder/Inbox',
      icon: 'mail',
    },
    {
      title: 'Outbox',
      url: '/folder/Outbox',
      icon: 'paper-plane',
    },
  ];
  public labels = ['Family', 'Friends'];

  constructor(
    private platform: Platform,
    private translate: TranslateService,
    public settingsQuery: SettingsQuery,
    private cofixService: CofiXService,
    private router: Router,
    private metadataQuery: MetadataQuery,
    private metadataService: MetadataService,
    @Inject('persistStorage') private persistStorage
  ) {
    this.initializeApp();
  }

  initializeApp() {
    this.platform.ready().then(() => {
      this.initConnectIfEnabled();
      this.initTranslate();
      this.cleanOldStorageSchemas();
    });
  }

  initTranslate() {
    this.translate.use(this.settingsQuery.lang());
    this.translate.setDefaultLang('en');
  }

  async initConnectIfEnabled() {
    if (await this.cofixService.isEnabled()) {
      await this.cofixService.connectSilently();
    }
  }

  cleanOldStorageSchemas() {
    const version = this.metadataQuery.dbVersion();
    if (!version || version !== DB_VERSION) {
      console.log(`clean old storage schema: ${version} -> ${DB_VERSION}`);

      this.persistStorage.clearStore();
      this.metadataService.updateDbVersion(DB_VERSION);
    }
  }

  ngOnInit() {
    this.router.navigateByUrl(this.settingsQuery.activeTab()).catch((e) => {
      this.router.navigateByUrl('swap');
    });
  }
}
