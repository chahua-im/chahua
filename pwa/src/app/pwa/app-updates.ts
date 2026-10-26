import { computed, inject, InjectionToken, isDevMode, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate } from '@angular/service-worker';
import { firstValueFrom, from, map, of, ReplaySubject, switchMap, timeout } from 'rxjs';
import { appVersion } from '../app-version';

export enum UpdateCheckResult {
  Updated = 'updated',
  Current = 'current',
  Unavailable = 'unavailable',
  Failed = 'failed',
}

export const APP_UPDATES_ENABLED = new InjectionToken<boolean>('APP_UPDATES_ENABLED', {
  providedIn: 'root',
  factory: () => !isDevMode(),
});

@Service()
export class AppUpdates {
  private readonly updates = inject(SwUpdate);
  private readonly checkingState = signal(false);
  private readonly availableState = signal(false);
  private readonly latestVersion = signal(window.chahuaUpdates?.latestVersion);
  private readonly dismissedVersion = signal<string | undefined>(undefined);
  private readonly interactive = signal(false);
  private pendingCheck?: Promise<UpdateCheckResult>;
  private download?: { hash: string; ready: ReplaySubject<boolean> };
  readonly supported = inject(APP_UPDATES_ENABLED) && this.updates.isEnabled;
  readonly version = appVersion;
  readonly checking = this.checkingState.asReadonly();
  readonly available = computed(() => this.availableState() || !!this.latestVersion());
  readonly promptOpen = computed(
    () => this.interactive() && !!this.latestVersion() && this.latestVersion() !== this.dismissedVersion(),
  );

  constructor() {
    this.updates.versionUpdates.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === 'VERSION_DETECTED' && event.version.hash !== this.download?.hash) {
        this.download?.ready.next(false);
        this.download = { hash: event.version.hash, ready: new ReplaySubject<boolean>(1) };
      } else if (event.type === 'VERSION_READY') {
        this.latestVersion.set(event.latestVersion.hash);
        this.download?.ready.next(true);
        this.download = undefined;
      } else if (event.type === 'VERSION_INSTALLATION_FAILED' && event.version.hash === this.download?.hash) {
        this.download.ready.next(false);
        this.download = undefined;
      }
    });
  }

  setInteractive(value: boolean) {
    this.interactive.set(value);
    window.chahuaUpdates?.setInteractive(value);
  }

  readonly dismiss = () => this.dismissedVersion.set(this.latestVersion());

  check(): Promise<UpdateCheckResult> {
    if (!this.supported) return Promise.resolve(UpdateCheckResult.Unavailable);
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
    let confirmedCurrent = false;
    let failed = false;
    const subscription = this.updates.versionUpdates.subscribe((event) => {
      if (event.type === 'NO_NEW_VERSION_DETECTED') confirmedCurrent = true;
      if (event.type === 'VERSION_INSTALLATION_FAILED') failed = true;
    });
    try {
      return await firstValueFrom(
        from(this.updates.checkForUpdate()).pipe(
          switchMap((downloaded) => {
            if (downloaded) this.availableState.set(true);
            return this.download?.ready ?? of(true);
          }),
          map((ready) => {
            if (!ready) return UpdateCheckResult.Failed;
            // The early listener can receive readiness before Angular subscribes.
            const earlyVersion = window.chahuaUpdates?.latestVersion;
            if (earlyVersion) this.latestVersion.set(earlyVersion);
            if (this.available()) return UpdateCheckResult.Updated;
            return confirmedCurrent && !failed ? UpdateCheckResult.Current : UpdateCheckResult.Failed;
          }),
          timeout(15000),
        ),
      );
    } catch {
      return UpdateCheckResult.Failed;
    } finally {
      subscription.unsubscribe();
    }
  }
}
