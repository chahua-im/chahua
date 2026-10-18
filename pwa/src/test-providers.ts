import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTransloco, type Translation, type TranslocoLoader } from '@jsverse/transloco';
import { ModalController } from '@ionic/angular';
import { of } from 'rxjs';
import en from './i18n/en.json';
import zhCN from './i18n/zh-CN.json';
import zhTW from './i18n/zh-TW.json';

const catalogs: Record<string, Translation> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW };

class TestTranslocoLoader implements TranslocoLoader {
  getTranslation(lang: string) {
    return of(catalogs[lang] ?? en);
  }
}

export default [
  provideRouter([]),
  provideHttpClient(),
  provideHttpClientTesting(),
  provideTransloco({
    config: {
      availableLangs: ['en', 'zh-CN', 'zh-TW'],
      defaultLang: 'zh-CN',
      fallbackLang: 'zh-CN',
      reRenderOnLangChange: true,
      prodMode: true,
      missingHandler: { logMissingKey: false, useFallbackTranslation: true, allowEmpty: true },
    },
    loader: TestTranslocoLoader,
  }),
  {
    provide: ModalController,
    useValue: {
      create: () => Promise.reject(new Error('Provide a dialog mock in this test')),
      dismiss: () => Promise.resolve(true),
      getTop: () => Promise.resolve(undefined),
    },
  },
];
