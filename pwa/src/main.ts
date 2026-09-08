import { inject, isDevMode, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import { AppUpdates } from './app/pwa/app-updates';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';

import { routes } from './app/app.routes';
import { App } from './app/app/app';
import { provideChahuaBaseUrl } from './generated/endpoints/chahua.base-url';
import { authInterceptor } from './app/api/auth.interceptor';
import { jsonInterceptor } from './app/api/json.interceptor';

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
    provideServiceWorker('push-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:3000',
      updateViaCache: 'none',
    }),
    provideAppInitializer(() => {
      inject(AppUpdates);
    }),
    provideHttpClient(withInterceptors([authInterceptor, jsonInterceptor])),
    provideChahuaBaseUrl('/_api'),
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular({
      mode: 'ios',
      useSetInputAPI: true,
    }),
    provideRouter(routes, withComponentInputBinding()),
  ],
});
