import { DOCUMENT } from '@angular/common';
import { inject, Injector, Service, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { type AppLocale, defaultLocale, detectLocale, isAppLocale } from '../settings/locale';
import { Preferences } from '../settings/preferences';

@Service()
export class Localization {
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly active = signal<AppLocale>(this.initialLocale());
  private request = 0;
  readonly locale = this.active.asReadonly();

  /** Runs before the first render so the saved language never flashes. */
  async initialize() {
    try {
      await this.setLocale(this.injector.get(Preferences).selectedLocale());
    } catch {
      this.setActive(defaultLocale);
    }
  }

  async setLocale(locale: AppLocale | null): Promise<boolean> {
    const request = ++this.request;
    const resolved = locale ?? detectLocale();
    try {
      await firstValueFrom(this.transloco.load(resolved));
    } catch (error) {
      if (request !== this.request) return false;
      throw error;
    }
    if (request !== this.request) return false;
    this.setActive(resolved);
    this.injector.get(Preferences).setLocale(locale);
    return true;
  }

  private setActive(locale: AppLocale) {
    this.transloco.setActiveLang(locale);
    this.active.set(locale);
    this.document.documentElement.lang = locale;
  }

  private initialLocale(): AppLocale {
    const configured = this.transloco.getActiveLang();
    return isAppLocale(configured) ? configured : defaultLocale;
  }
}
