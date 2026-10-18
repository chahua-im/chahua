import { inject, Pipe, type PipeTransform } from '@angular/core';
import { Localization } from '../i18n/localization';

const day = 24 * 60 * 60 * 1000;

function dateFormats(locale: string) {
  const key = locale;
  let value = formats.get(key);
  if (!value) {
    value = {
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
      monthDay: new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }),
      shortDate: new Intl.DateTimeFormat(locale, { dateStyle: 'short' }),
    };
    formats.set(key, value);
  }
  return value;
}

const formats = new Map<
  string,
  {
    time: Intl.DateTimeFormat;
    weekday: Intl.DateTimeFormat;
    monthDay: Intl.DateTimeFormat;
    shortDate: Intl.DateTimeFormat;
  }
>();

// Re-evaluate elapsed time when the view is checked, without per-row refresh timers.
@Pipe({ name: 'chatDate', pure: false })
export class ChatDatePipe implements PipeTransform {
  private readonly localization = inject(Localization);

  transform(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    const now = new Date();
    const age = Math.abs(now.getTime() - date.getTime());
    const fmt = dateFormats(this.localization.locale());
    if (age >= 365 * day) return fmt.shortDate.format(date);

    // Compare local calendar days, independent of daylight-saving day lengths.
    const calendarDay = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
    const daysAgo = (calendarDay(now) - calendarDay(date)) / day;
    if (daysAgo === 0 || (daysAgo === 1 && age < 8 * 60 * 60 * 1000)) return fmt.time.format(date);
    return (daysAgo >= 1 && daysAgo < 7 ? fmt.weekday : fmt.monthDay).format(date);
  }
}
