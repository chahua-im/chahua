import { TestBed } from '@angular/core/testing';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
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
    delete window.chahuaUpdates;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the default build version and reports unavailable without a registered worker', async () => {
    worker.isEnabled = false;
    const service = TestBed.inject(AppUpdates);
    expect(service.version).toBe('PWA2-dev');
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

  it('remembers an early update and offers each version once while the app is interactive', () => {
    window.chahuaUpdates = { latestVersion: 'new', setInteractive: vi.fn() };
    const service = TestBed.inject(AppUpdates);
    expect(service.available()).toBe(true);
    expect(service.promptOpen()).toBe(false);
    service.setInteractive(true);
    expect(window.chahuaUpdates.setInteractive).toHaveBeenCalledWith(true);
    expect(service.promptOpen()).toBe(true);
    service.dismiss();
    events.next({ type: 'VERSION_READY', currentVersion: { hash: 'old' }, latestVersion: { hash: 'new' } });
    expect(service.promptOpen()).toBe(false);
    expect(service.available()).toBe(true);
    events.next({ type: 'VERSION_READY', currentVersion: { hash: 'old' }, latestVersion: { hash: 'newer' } });
    expect(service.promptOpen()).toBe(true);
    service.setInteractive(false);
    expect(service.promptOpen()).toBe(false);
    expect(window.chahuaUpdates.setInteractive).toHaveBeenLastCalledWith(false);
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
    const install = TestBed.inject(AppUpdates).reload;
    install();
    expect(reload).toHaveBeenCalledOnce();
  });
});
