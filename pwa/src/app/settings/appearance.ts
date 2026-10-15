import { effect, inject, Service, signal } from '@angular/core';
import { applyColorMode, resolveDarkMode } from './color-mode';
import { Preferences } from './preferences';

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

/** Applies the persisted color mode to the document, tracking the system preference while set to follow it. */
@Service()
export class Appearance {
  private readonly preferences = inject(Preferences);
  private readonly darkQuery = window.matchMedia(DARK_MODE_QUERY);
  private readonly systemDark = signal(this.darkQuery.matches);

  constructor() {
    this.darkQuery.addEventListener('change', (event) => this.systemDark.set(event.matches));
    effect(() => applyColorMode(resolveDarkMode(this.preferences.colorMode(), this.systemDark())));
  }
}
