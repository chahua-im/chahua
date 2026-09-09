import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { CHAHUA_BASE_URL } from '../../generated/endpoints/chahua.base-url';
import { SessionStore } from '../session/session-store';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const baseUrl = inject(CHAHUA_BASE_URL);
  if (!request.url.startsWith(`${baseUrl}/`)) return next(request);

  const session = inject(SessionStore);
  const token = session.token();
  const savedSnapshot = /(?:^|\/)saved-messages(?:[/?]|$)/.test(request.url.slice(baseUrl.length));
  return next(
    request.clone({
      setHeaders: {
        'X-App-Version': CHAHUA_APP_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }),
  ).pipe(
    tap((event) => {
      if (!savedSnapshot && event instanceof HttpResponse && request.responseType === 'json')
        session.updateProfile(event.body);
    }),
  );
};
