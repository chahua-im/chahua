import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type { Translation, TranslocoLoader } from '@jsverse/transloco';

@Service()
export class TranslocoHttpLoader implements TranslocoLoader {
  private readonly http = inject(HttpClient);

  getTranslation(lang: string) {
    return this.http.get<Translation>(`i18n/${lang}.json`);
  }
}
