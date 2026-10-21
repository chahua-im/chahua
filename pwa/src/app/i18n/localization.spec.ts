import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { Preferences } from '../settings/preferences';
import { Localization } from './localization';

describe('Localization requests', () => {
  let english: Subject<object>;
  let traditional: Subject<object>;
  const setLocale = vi.fn();
  const setActiveLang = vi.fn();
  beforeEach(() => {
    english = new Subject();
    traditional = new Subject();
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: Preferences, useValue: { setLocale } },
        {
          provide: TranslocoService,
          useValue: {
            getActiveLang: () => 'zh-CN',
            setActiveLang,
            load: (locale: string) => (locale === 'en' ? english : traditional),
          },
        },
      ],
    });
  });

  it('keeps the current language and preference when a catalog fails', async () => {
    const service = TestBed.inject(Localization);
    const pending = service.setLocale('en');
    const rejection = expect(pending).rejects.toThrow('offline');
    english.error(new Error('offline'));
    await rejection;
    expect(service.locale()).toBe('zh-CN');
    expect(setLocale).not.toHaveBeenCalled();
    expect(setActiveLang).not.toHaveBeenCalled();
  });

  it('does not let a delayed previous selection override the latest language', async () => {
    const service = TestBed.inject(Localization);
    const first = service.setLocale('en');
    const last = service.setLocale('zh-TW');
    traditional.next({});
    expect(await last).toBe(true);
    english.next({});
    expect(await first).toBe(false);
    expect(service.locale()).toBe('zh-TW');
    expect(setLocale).toHaveBeenCalledExactlyOnceWith('zh-TW');
  });
});
