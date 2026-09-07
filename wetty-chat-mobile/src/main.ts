import { inject, isDevMode, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import { AppUpdates } from './app/pwa/app-updates';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  RouteReuseStrategy,
  provideRouter,
  withComponentInputBinding,
  withPreloading,
  PreloadAllModules,
} from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';

import { routes } from './app/app.routes';
import { App } from './app/app';
import { provideChahuaBaseUrl } from './generated/endpoints/chahua.base-url';
import { authInterceptor } from './app/api/auth.interceptor';
import { jsonInterceptor } from './app/api/json.interceptor';

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
      focusManagerPriority: ['heading', 'banner', 'content'],
    }),
    provideRouter(
      routes,
      withPreloading(PreloadAllModules),
      withComponentInputBinding(),
    ),
  ],
});
