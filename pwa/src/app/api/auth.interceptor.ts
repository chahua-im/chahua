import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { CHAHUA_BASE_URL } from '../../generated/endpoints/chahua.base-url';
import { SessionStore } from '../session/session-store';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const baseUrl = inject(CHAHUA_BASE_URL);
  if (!request.url.startsWith(`${baseUrl}/`)) return next(request);

  const token = inject(SessionStore).token();
  return next(
    request.clone({
      setHeaders: {
        'X-App-Version': 'angular-pwa/0.0.0',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }),
  );
};
