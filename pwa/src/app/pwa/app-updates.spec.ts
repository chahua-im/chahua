import { signal } from '@angular/core';
import { AlertController } from '@ionic/angular';
import { MessageOutbox } from '../messages/message-outbox';
import { MessageDelivery } from '../messages/message-delivery';
import { TestBed } from '@angular/core/testing';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { firstValueFrom, Subject, timer } from 'rxjs';
import { vi } from 'vitest';
import { APP_UPDATES_ENABLED, AppUpdates, UpdateCheckResult } from './app-updates';

describe('AppUpdates', () => {
  let events: Subject<VersionEvent>;
  let worker: { isEnabled: boolean; versionUpdates: Subject<VersionEvent>; checkForUpdate: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    events = new Subject();
    worker = { isEnabled: true, versionUpdates: events, checkForUpdate: vi.fn().mockResolvedValue(false) };
    TestBed.configureTestingModule({
      providers: [
        { provide: SwUpdate, useValue: worker },
        { provide: MessageOutbox, useValue: { items: signal([]) } },
        { provide: APP_UPDATES_ENABLED, useValue: true },
      ],
    });
  });
  afterEach(() => {
    delete window.chahuaUpdates;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not send update requests to the development notification worker', async () => {
    TestBed.overrideProvider(APP_UPDATES_ENABLED, { useValue: false });
    const service = TestBed.inject(AppUpdates);
    expect(service.supported).toBe(false);
    expect(await service.check()).toBe(UpdateCheckResult.Unavailable);
    expect(worker.checkForUpdate).not.toHaveBeenCalled();
  });

  it('reports unavailable without a registered worker', async () => {
    worker.isEnabled = false;
    const service = TestBed.inject(AppUpdates);
    expect(await service.check()).toBe(UpdateCheckResult.Unavailable);
    expect(worker.checkForUpdate).not.toHaveBeenCalled();
  });

  it('checks the actual Angular worker and distinguishes current from downloaded updates', async () => {
    const service = TestBed.inject(AppUpdates);
    worker.checkForUpdate.mockImplementation(async () => {
      events.next({ type: 'NO_NEW_VERSION_DETECTED', version: { hash: 'current' } });
      return false;
    });
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

  it('waits for a background download instead of reporting current', async () => {
    const service = TestBed.inject(AppUpdates);
    events.next({ type: 'VERSION_DETECTED', version: { hash: 'new' } });
    worker.checkForUpdate.mockImplementation(async () => {
      events.next({ type: 'NO_NEW_VERSION_DETECTED', version: { hash: 'new' } });
      return false;
    });
    const check = service.check();
    let result: UpdateCheckResult | undefined;
    void check.then((value) => (result = value));
    await firstValueFrom(timer(0));
    expect(result).toBeUndefined();
    expect(service.checking()).toBe(true);
    events.next({ type: 'VERSION_READY', currentVersion: { hash: 'old' }, latestVersion: { hash: 'new' } });
    expect(await check).toBe(UpdateCheckResult.Updated);
  });

  it('does not report current when the worker fails to download the update', async () => {
    const service = TestBed.inject(AppUpdates);
    worker.checkForUpdate.mockImplementation(async () => {
      events.next({ type: 'VERSION_DETECTED', version: { hash: 'new' } });
      events.next({ type: 'VERSION_INSTALLATION_FAILED', version: { hash: 'new' }, error: 'download failed' });
      return false;
    });
    expect(await service.check()).toBe(UpdateCheckResult.Failed);
  });

  it('reports a background download failure and allows a successful retry', async () => {
    const service = TestBed.inject(AppUpdates);
    events.next({ type: 'VERSION_DETECTED', version: { hash: 'new' } });
    const check = service.check();
    await firstValueFrom(timer(0));
    events.next({ type: 'VERSION_INSTALLATION_FAILED', version: { hash: 'new' }, error: 'download failed' });
    expect(await check).toBe(UpdateCheckResult.Failed);
    worker.checkForUpdate.mockImplementation(async () => {
      events.next({ type: 'VERSION_DETECTED', version: { hash: 'new' } });
      events.next({ type: 'VERSION_READY', currentVersion: { hash: 'old' }, latestVersion: { hash: 'new' } });
      return true;
    });
    expect(await service.check()).toBe(UpdateCheckResult.Updated);
  });

  it('times out a stalled background download without losing a later ready update', async () => {
    vi.useFakeTimers();
    const service = TestBed.inject(AppUpdates);
    events.next({ type: 'VERSION_DETECTED', version: { hash: 'new' } });
    const check = service.check();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await check).toBe(UpdateCheckResult.Failed);
    expect(service.checking()).toBe(false);
    events.next({ type: 'VERSION_READY', currentVersion: { hash: 'old' }, latestVersion: { hash: 'new' } });
    expect(service.available()).toBe(true);
  });

  it('does not report current when an offline worker returns false without checking a version', async () => {
    const service = TestBed.inject(AppUpdates);
    expect(await service.check()).toBe(UpdateCheckResult.Failed);
  });

  it('recovers readiness received by the early listener after service construction', async () => {
    window.chahuaUpdates = { latestVersion: undefined, setInteractive: vi.fn() };
    const service = TestBed.inject(AppUpdates);
    window.chahuaUpdates.latestVersion = 'new';
    expect(await service.check()).toBe(UpdateCheckResult.Updated);
    expect(service.available()).toBe(true);
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
  it.each([MessageDelivery.Sending, MessageDelivery.Uploading, MessageDelivery.Failed])(
    'confirms updates with unfinished delivery %s and keeps tasks on cancellation',
    async (delivery) => {
      const reload = vi.fn();
      vi.stubGlobal('window', { location: { reload } });
      const items = signal([{ delivery: signal(delivery), cancelled: signal(false) }]);
      const present = vi.fn();
      const create = vi.fn().mockResolvedValue({ present, onDidDismiss: async () => ({ role: 'cancel' }) });
      TestBed.overrideProvider(MessageOutbox, { useValue: { items } });
      TestBed.configureTestingModule({ providers: [{ provide: AlertController, useValue: { create } }] });
      const service = TestBed.inject(AppUpdates);
      await service.reload();
      expect(present).toHaveBeenCalledOnce();
      expect(reload).not.toHaveBeenCalled();
      expect(items()).toHaveLength(1);
      create.mockResolvedValueOnce({ present, onDidDismiss: async () => ({ role: 'destructive' }) });
      await service.reload();
      expect(reload).toHaveBeenCalledOnce();
    },
  );
  it('does not warn for sent or cancelled messages', async () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    TestBed.overrideProvider(MessageOutbox, {
      useValue: {
        items: () => [
          { delivery: () => MessageDelivery.Sent, cancelled: () => false },
          { delivery: () => MessageDelivery.Failed, cancelled: () => true },
        ],
      },
    });
    await TestBed.inject(AppUpdates).reload();
    expect(reload).toHaveBeenCalledOnce();
  });
});
