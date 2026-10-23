import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { Localization } from '../i18n/localization';
import { MessageDatePipe } from './message-date.pipe';

describe('MessageDatePipe', () => {
  const locale = signal('zh-CN');
  let pipe: MessageDatePipe;

  beforeEach(async () => {
    locale.set('zh-CN');
    TestBed.configureTestingModule({
      providers: [MessageDatePipe, { provide: Localization, useValue: { locale } }],
    });
    await setLocale('zh-CN');
    pipe = TestBed.inject(MessageDatePipe);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 23, 12));
  });

  afterEach(() => vi.useRealTimers());

  async function setLocale(language: string) {
    const transloco = TestBed.inject(TranslocoService);
    await firstValueFrom(transloco.load(language));
    transloco.setActiveLang(language);
    locale.set(language);
  }

  it('uses today and yesterday for local calendar dates, including messages over 24 hours old', () => {
    expect(pipe.transform(new Date(2026, 9, 23, 0, 5).toISOString())).toBe('今天');
    expect(pipe.transform(new Date(2026, 9, 22, 0, 5).toISOString())).toBe('昨天');
    expect(pipe.transform(new Date(2026, 9, 22, 14, 30).toISOString(), 'dateTime')).toBe('昨天 14:30');
  });

  it('checks yesterday before the year boundary and re-evaluates unchanged inputs after midnight', () => {
    const date = new Date(2026, 11, 31, 23, 59);
    vi.setSystemTime(date);
    expect(pipe.transform(date)).toBe('今天');
    vi.setSystemTime(new Date(2027, 0, 1, 0, 1));
    expect(pipe.transform(date)).toBe('昨天');
    vi.setSystemTime(new Date(2027, 0, 2, 0, 1));
    expect(pipe.transform(date)).toBe('2026年12月31日');
  });

  it('omits this year but retains the year on older messages, also in date-time labels', () => {
    expect(pipe.transform(new Date(2026, 9, 20, 14, 30))).toBe('10月20日');
    expect(pipe.transform(new Date(2025, 9, 20, 14, 30), 'dateTime')).toBe('2025年10月20日 14:30');
  });

  it('compares calendar days across daylight-saving transitions', () => {
    for (const [month, day] of [
      [2, 9],
      [10, 2],
    ]) {
      vi.setSystemTime(new Date(2026, month, day, 0, 30));
      expect(pipe.transform(new Date(2026, month, day - 1, 0, 5).toISOString())).toBe('昨天');
      expect(pipe.transform(new Date(2026, month, day - 2, 23, 55).toISOString())).not.toBe('昨天');
    }
  });

  it('updates both relative labels and dates when the application language changes', async () => {
    const yesterday = new Date(2026, 9, 22, 14, 30);
    const earlier = new Date(2026, 9, 20, 14, 30);
    for (const [language, today, previous, date] of [
      ['en', 'Today', 'Yesterday', 'Oct 20'],
      ['zh-TW', '今天', '昨天', '10月20日'],
      ['zh-CN', '今天', '昨天', '10月20日'],
    ]) {
      await setLocale(language);
      expect(pipe.transform(new Date())).toBe(today);
      expect(pipe.transform(yesterday, 'dateTime')).toBe(`${previous} 14:30`);
      expect(pipe.transform(earlier)).toBe(date);
    }
  });

  it.each([null, undefined, '', 'invalid'])('renders a missing or invalid timestamp as empty: %s', (value) => {
    expect(pipe.transform(value)).toBe('');
  });

  it('accepts numeric timestamps without treating the Unix epoch as missing', () => {
    const date = new Date(0);
    expect(pipe.transform(0)).toBe(
      new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date),
    );
  });
});
