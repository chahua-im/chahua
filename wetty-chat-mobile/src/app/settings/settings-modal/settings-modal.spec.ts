import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { routes } from '../../app.routes';
import { SettingsModal } from './settings-modal';
import { SettingsDismissRole } from '../settings/settings';

describe('SettingsModal history', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'chats/saved', children: [] },
          { path: 'chats', children: [] },
          routes.find((route) => route.path === 'settings')!,
        ]),
        provideLocationMocks(),
      ],
    });
    TestBed.overrideComponent(SettingsModal, { set: { template: '' } });
    TestBed.inject(Router).setUpLocationChangeListener();
  });

  it('tracks browser back and forward without going back twice on dismissal', async () => {
    const fixture = TestBed.createComponent(SettingsModal);
    const router = TestBed.inject(Router);
    const location = TestBed.inject(Location);
    await router.navigateByUrl('/chats');
    await router.navigateByUrl('/chats?settings=1', { browserUrl: '/settings', state: { settingsEntry: true } });
    expect(fixture.componentInstance['open']()).toBe(true);
    location.back();
    await vi.waitFor(() => expect(fixture.componentInstance['open']()).toBe(false));
    const back = vi.spyOn(location, 'back');
    fixture.componentInstance['dismissed']({});
    expect(back).not.toHaveBeenCalled();
    location.forward();
    await vi.waitFor(() => expect(fixture.componentInstance['open']()).toBe(true));
  });

  it('keeps the active route while displaying the settings address', async () => {
    const fixture = TestBed.createComponent(SettingsModal);
    const router = TestBed.inject(Router);
    const location = TestBed.inject(Location);
    await router.navigateByUrl('/chats?keep=1');
    const active = router.routerState.root.firstChild;
    await router.navigateByUrl('/chats?keep=1&settings=1', {
      browserUrl: '/settings',
      state: { settingsEntry: true },
    });
    expect(location.path()).toBe('/settings');
    expect(router.routerState.root.firstChild).toBe(active);
    expect(router.url).toBe('/chats?keep=1&settings=1');
    expect(fixture.componentInstance['open']()).toBe(true);
  });

  it('returns to the previous entry when Done or the backdrop closes settings', async () => {
    const fixture = TestBed.createComponent(SettingsModal);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/chats?keep=1');
    await router.navigateByUrl('/chats?keep=1&settings=1', { browserUrl: '/settings', state: { settingsEntry: true } });
    fixture.componentInstance['dismissed']({});
    await vi.waitFor(() => expect(router.url).toBe('/chats?keep=1'));
  });

  it('returns a direct settings link to chats without leaving the application', async () => {
    const fixture = TestBed.createComponent(SettingsModal);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/settings?keep=1');
    const back = vi.spyOn(TestBed.inject(Location), 'back');
    await fixture.componentInstance['dismissed']({});
    expect(router.url).toBe('/chats');
    expect(back).not.toHaveBeenCalled();
  });

  it('replaces the settings entry with saved messages', async () => {
    const fixture = TestBed.createComponent(SettingsModal);
    const router = TestBed.inject(Router);
    const location = TestBed.inject(Location);
    await router.navigateByUrl('/chats');
    await router.navigateByUrl('/chats?settings=1', { browserUrl: '/settings', state: { settingsEntry: true } });
    await fixture.componentInstance['dismissed']({ role: SettingsDismissRole.Saved });
    expect(router.url).toBe('/chats/saved');
    location.back();
    await vi.waitFor(() => expect(router.url).toBe('/chats'));
  });
});
