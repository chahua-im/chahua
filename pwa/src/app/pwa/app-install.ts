import { computed, DestroyRef, inject, Service, signal } from '@angular/core';

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

@Service()
export class AppInstall {
  private readonly prompt = signal<InstallPrompt | undefined>(undefined);
  readonly available = computed(() => !!this.prompt());

  constructor() {
    const capture = (event: Event) => {
      event.preventDefault();
      this.prompt.set(event as InstallPrompt);
    };
    const installed = () => this.prompt.set(undefined);
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', installed);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', installed);
    });
  }

  async install() {
    const prompt = this.prompt();
    if (!prompt) return;
    this.prompt.set(undefined);
    try {
      await prompt.prompt();
    } catch {
      // The browser may withdraw installability after the event was captured.
    }
  }
}
