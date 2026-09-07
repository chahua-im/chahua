import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { map } from 'rxjs';
import { CHAHUA_BASE_URL } from '../../generated/endpoints/chahua.base-url';
import { jsonOperations } from '../../generated/json-codecs';
import { normalizeJson, serializeJson } from './normalize-json';
import { decodeId, type SnowflakeID } from './snowflake-id';

const operations = jsonOperations.map((operation) => ({
  ...operation,
  route: new RegExp(`^${operation.path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
}));

export const jsonInterceptor: HttpInterceptorFn = (request, next) => {
  const baseUrl = inject(CHAHUA_BASE_URL);
  if (!request.url.startsWith(`${baseUrl}/`)) return next(request);
  const path = request.url.slice(baseUrl.length).split('?')[0];
  const operation = operations.find((candidate) => candidate.method === request.method && candidate.route.test(path));
  let params = request.params;
  for (const key of Object.keys(operation?.query ?? {})) {
    const values = params.getAll(key);
    if (values) {
      params = params.delete(key);
      for (const value of values) params = params.append(key, decodeId(Number(value) as SnowflakeID));
    }
  }
  const body = operation?.body === undefined ? request.body : serializeJson(request.body, operation.body);

  return next(request.clone({ params, body })).pipe(
    map((event) =>
      event instanceof HttpResponse && request.responseType === 'json' && event.body !== null
        ? event.clone({ body: normalizeJson(event.body, operation?.response) })
        : event,
    ),
  );
};
