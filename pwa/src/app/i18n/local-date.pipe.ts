import { inject, Pipe, type PipeTransform } from '@angular/core';
import { Localization } from './localization';

export type LocalDateFormat = 'date' | 'time' | 'short' | 'monthDayTime';

const options: Record<LocalDateFormat, Intl.DateTimeFormatOptions> = {
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  short: { dateStyle: 'short' },
  monthDayTime: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, format: LocalDateFormat) {
  const key = `${locale}:${format}`;
  let value = formatters.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(locale, options[format]);
    formatters.set(key, value);
  }
  return value;
}

@Pipe({ name: 'localDate', pure: false })
export class LocalDatePipe implements PipeTransform {
  private readonly localization = inject(Localization);

  transform(value: string | Date | number | null | undefined, format: LocalDateFormat = 'date'): string {
    if (value == null || value === '') return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return formatter(this.localization.locale(), format).format(date);
  }
}
