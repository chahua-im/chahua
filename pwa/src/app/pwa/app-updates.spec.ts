import { TestBed } from '@angular/core/testing';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { version } from '../../../package.json';
import { AppUpdates, UpdateCheckResult } from './app-updates';

describe('AppUpdates', () => {
  let events: Subject<VersionEvent>;
  let worker: { isEnabled: boolean; versionUpdates: Subject<VersionEvent>; checkForUpdate: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    events = new Subject();
    worker = { isEnabled: true, versionUpdates: events, checkForUpdate: vi.fn().mockResolvedValue(false) };
    TestBed.configureTestingModule({ providers: [{ provide: SwUpdate, useValue: worker }] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the package version and reports unavailable without a registered worker', async () => {
    worker.isEnabled = false;
    const service = TestBed.inject(AppUpdates);
    expect(service.version).toBe(version);
    expect(await service.check()).toBe(UpdateCheckResult.Unavailable);
    expect(worker.checkForUpdate).not.toHaveBeenCalled();
  });

  it('checks the actual Angular worker and distinguishes current from downloaded updates', async () => {
    const service = TestBed.inject(AppUpdates);
    expect(await service.check()).toBe(UpdateCheckResult.Current);
    worker.checkForUpdate.mockResolvedValue(true);
    expect(await service.check()).toBe(UpdateCheckResult.Updated);
    expect(service.available()).toBe(true);
    expect(service.checking()).toBe(false);
  });

  it('retains an already downloaded update even when the latest check has no new version', async () => {
    const service = TestBed.inject(AppUpdates);
    events.next({ type: 'VERSION_READY', currentVersion: { hash: 'old' }, latestVersion: { hash: 'new' } });
    expect(await service.check()).toBe(UpdateCheckResult.Updated);
  });

  it('shares a pending check and restores loading state after a failed request', async () => {
    worker.checkForUpdate.mockRejectedValue(new Error('offline'));
    const service = TestBed.inject(AppUpdates);
    const check = service.check();
    expect(service.check()).toBe(check);
    expect(await check).toBe(UpdateCheckResult.Failed);
    expect(service.checking()).toBe(false);
    expect(worker.checkForUpdate).toHaveBeenCalledOnce();
  });

  it('times out instead of leaving a permanently spinning check', async () => {
    vi.useFakeTimers();
    worker.checkForUpdate.mockReturnValue(new Promise(() => {}));
    const service = TestBed.inject(AppUpdates);
    const check = service.check();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await check).toBe(UpdateCheckResult.Failed);
    expect(service.checking()).toBe(false);
  });

  it('reloads the whole document to activate a ready version safely', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    TestBed.inject(AppUpdates).reload();
    expect(reload).toHaveBeenCalledOnce();
  });
});
