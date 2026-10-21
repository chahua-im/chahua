import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { LastSeenBucket } from '../../generated/models/lastSeenBucket';
import type { UserPresenceResponse } from '../../generated/models/userPresenceResponse';
import { Localization } from '../i18n/localization';
import { Presence } from './presence';
import { UserPresenceDisplay } from './presence-display';

describe('UserPresenceDisplay', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('switches exact time to private text in place and suppresses the online indicator', async () => {
    const state = signal<UserPresenceResponse | undefined>({
      uid: 2,
      online: false,
      lastSeenAt: new Date(2026, 9, 21, 2, 32).toISOString(),
    });
    const locale = signal('zh-CN');
    const loading = signal(false);
    const live = signal(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: Localization, useValue: { locale } },
        {
          provide: Presence,
          useValue: {
            user: state,
            userLoading: loading,
            live,
            now: () => new Date(2026, 9, 21, 16).getTime(),
            watch: () => () => {},
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(UserPresenceDisplay);
    fixture.componentRef.setInput('uid', 2);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('最近上线于今天 02:32');
    state.set({ uid: 2, online: false, lastSeenAt: new Date(2026, 9, 19, 14, 32).toISOString() });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('最近上线于 10月19日 14:32');
    expect(fixture.nativeElement.textContent).not.toContain('2026');
    state.set({ uid: 2, online: false, lastSeenAt: new Date(2025, 9, 19, 14, 32).toISOString() });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('2025年10月19日');
    state.set({ uid: 2, online: false, lastSeenAt: new Date(2026, 9, 21, 15, 58).toISOString() });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('最近上线于 2 分钟前');
    state.set({ uid: 2, online: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.online')).not.toBeNull();
    state.set({ uid: 2, online: false, away: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('离开');
    expect(fixture.nativeElement.querySelector('.online')).toBeNull();
    for (const [bucket, text] of [
      [LastSeenBucket.recently, '最近上线'],
      [LastSeenBucket.withinWeek, '1 周内上线'],
      [LastSeenBucket.withinMonth, '1 个月内上线'],
      [LastSeenBucket.longAgo, '很久没上线'],
    ] as const) {
      state.set({ uid: 2, online: false, lastSeenBucket: bucket });
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(text);
      expect(fixture.nativeElement.textContent).not.toContain('02:32');
      expect(fixture.nativeElement.querySelector('.online')).toBeNull();
    }
    state.set(undefined);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('很久没上线');
    loading.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.presence-skeleton')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('很久没上线');
    loading.set(false);
    live.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
    live.set(true);
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
    fixture.componentRef.setInput('active', true);
    state.set({ uid: 2, online: false });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('很久没上线');
    locale.set('en');
    TestBed.inject(TranslocoService).setActiveLang('en');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Last seen a long time ago');
  });
});
