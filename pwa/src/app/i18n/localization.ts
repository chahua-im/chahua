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
  readonly locale = this.active.asReadonly();

  /** Runs before the first render so the saved language never flashes. */
  async initialize() {
    await this.activate(this.injector.get(Preferences).selectedLocale() ?? detectLocale());
  }

  async setLocale(locale: AppLocale | null) {
    this.injector.get(Preferences).setLocale(locale);
    await this.activate(locale ?? detectLocale());
  }

  private async activate(locale: AppLocale) {
    try {
      await firstValueFrom(this.transloco.load(locale));
      this.setActive(locale);
    } catch {
      // A failed catalog fetch should not block startup; keep the default language.
      this.setActive(defaultLocale);
    }
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
