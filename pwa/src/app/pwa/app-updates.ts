import { inject, Service, signal } from '@angular/core';
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
  private pendingCheck?: Promise<UpdateCheckResult>;
  readonly supported = this.updates.isEnabled;
  readonly version = CHAHUA_APP_VERSION;
  readonly checking = this.checkingState.asReadonly();
  readonly available = this.availableState.asReadonly();

  constructor() {
    this.updates.versionUpdates.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === 'VERSION_READY') this.availableState.set(true);
    });
  }

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

  reload(): void {
    // Reload lets Angular switch the entire document and its lazy chunks together.
    window.location.reload();
  }

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
