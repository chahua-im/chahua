import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AppInstall } from './app-install';

describe('AppInstall', () => {
  it('stays unavailable until the browser supplies an installation event', async () => {
    const service = TestBed.inject(AppInstall);
    expect(service.available()).toBe(false);
    await service.install();
    expect(service.available()).toBe(false);
  });

  it('prompts synchronously once per event and becomes available again only with a new event', async () => {
    const service = TestBed.inject(AppInstall);
    const prompt = vi.fn(async () => ({ outcome: 'dismissed' }));
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(service.available()).toBe(true);
    const installing = service.install();
    expect(prompt).toHaveBeenCalledOnce();
    expect(service.available()).toBe(false);
    await installing;
    await service.install();
    expect(prompt).toHaveBeenCalledOnce();
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt }));
    expect(service.available()).toBe(true);
  });

  it('clears a captured prompt when installation completes', async () => {
    const service = TestBed.inject(AppInstall);
    const prompt = vi.fn();
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt }));
    window.dispatchEvent(new Event('appinstalled'));
    expect(service.available()).toBe(false);
    await service.install();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('stays unavailable if the browser withdraws its prompt', async () => {
    const service = TestBed.inject(AppInstall);
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt'), { prompt: vi.fn().mockRejectedValue(new Error()) }),
    );
    await service.install();
    expect(service.available()).toBe(false);
  });
});
