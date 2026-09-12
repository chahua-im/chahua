import { computed, inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { firstValueFrom, from, timeout } from 'rxjs';

export enum UpdateCheckResult {
  Updated = 'updated',
  Current = 'current',
  Unavailable = 'unavailable',
  Failed = 'failed',
}

@Service()
export class AppUpdates {
  private readonly updates = inject(SwUpdate);
  private readonly checkingState = signal(false);
  private readonly availableState = signal(false);
  private readonly latestVersion = signal(window.chahuaUpdates?.latestVersion);
  private readonly dismissedVersion = signal<string | undefined>(undefined);
  private readonly interactive = signal(false);
  private pendingCheck?: Promise<UpdateCheckResult>;
  readonly supported = this.updates.isEnabled;
  readonly version = CHAHUA_APP_VERSION;
  readonly checking = this.checkingState.asReadonly();
  readonly available = computed(() => this.availableState() || !!this.latestVersion());
  readonly promptOpen = computed(
    () => this.interactive() && !!this.latestVersion() && this.latestVersion() !== this.dismissedVersion(),
  );

  constructor() {
    this.updates.versionUpdates.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === 'VERSION_READY') this.latestVersion.set(event.latestVersion.hash);
    });
  }

  setInteractive(value: boolean) {
    this.interactive.set(value);
    window.chahuaUpdates?.setInteractive(value);
  }

  readonly dismiss = () => this.dismissedVersion.set(this.latestVersion());

  check(): Promise<UpdateCheckResult> {
    if (!this.updates.isEnabled) return Promise.resolve(UpdateCheckResult.Unavailable);
    if (this.pendingCheck) return this.pendingCheck;
    this.checkingState.set(true);
    this.pendingCheck = this.checkForUpdate().finally(() => {
      this.checkingState.set(false);
      this.pendingCheck = undefined;
    });
    return this.pendingCheck;
  }

  readonly reload = () => {
    // Reload lets Angular switch the entire document and its lazy chunks together.
    window.location.reload();
  };

  private async checkForUpdate(): Promise<UpdateCheckResult> {
    try {
      if (await firstValueFrom(from(this.updates.checkForUpdate()).pipe(timeout(15000)))) {
        this.availableState.set(true);
      }
      return this.available() ? UpdateCheckResult.Updated : UpdateCheckResult.Current;
    } catch {
      return UpdateCheckResult.Failed;
    }
  }
}
