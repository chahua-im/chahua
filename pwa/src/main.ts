import { inject, isDevMode, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import { AppInstall } from './app/pwa/app-install';
import { AppUpdates } from './app/pwa/app-updates';
import { LegacyMigration } from './app/pwa/legacy-migration';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { provideTransloco } from '@jsverse/transloco';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';

import { routes } from './app/app.routes';
import { App } from './app/app/app';
import { provideChahuaBaseUrl } from './generated/endpoints/chahua.base-url';
import { authInterceptor } from './app/api/auth.interceptor';
import { jsonInterceptor } from './app/api/json.interceptor';
import { Appearance } from './app/settings/appearance';
import { Localization } from './app/i18n/localization';
import { TranslocoHttpLoader } from './app/i18n/transloco-http-loader';
import { defaultLocale, supportedLocales } from './app/settings/locale';

// https://stackoverflow.com/a/2117523/2800218
if (isDevMode() && typeof crypto.randomUUID !== 'function')
  crypto.randomUUID = function randomUUID() {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c: string) =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
    ) as ReturnType<Crypto['randomUUID']>;
  };

bootstrapApplication(App, {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideServiceWorker(isDevMode() ? 'serviceWorker.js?development=1' : 'serviceWorker.js', {
      enabled: true,
      registrationStrategy: isDevMode() ? 'registerImmediately' : 'registerWhenStable:3000',
      updateViaCache: 'none',
    }),
    provideTransloco({
      config: {
        availableLangs: [...supportedLocales],
        defaultLang: defaultLocale,
        fallbackLang: defaultLocale,
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
        missingHandler: { logMissingKey: isDevMode(), useFallbackTranslation: true, allowEmpty: true },
      },
      loader: TranslocoHttpLoader,
    }),
    provideAppInitializer(async () => {
      inject(AppInstall);
      inject(Appearance);
      inject(AppUpdates);
      const legacyMigration = inject(LegacyMigration);
      const localization = inject(Localization);
      await legacyMigration.run();
      await localization.initialize();
    }),
    provideHttpClient(withInterceptors([authInterceptor, jsonInterceptor])),
    provideChahuaBaseUrl(CHAHUA_API_BASE),
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular({
      mode: 'ios',
      backButtonText: '',
      spinner: 'circular',
      loadingSpinner: 'circular',
      refreshingSpinner: 'circular',
      infiniteLoadingSpinner: 'circular',
      useSetInputAPI: true,
    }),
    provideRouter(routes, withComponentInputBinding()),
  ],
});
