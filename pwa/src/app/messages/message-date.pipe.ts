import { inject, Pipe, type PipeTransform } from '@angular/core';
import { translateSignal } from '@jsverse/transloco';
import { formatLocalDate } from '../i18n/local-date.pipe';
import { Localization } from '../i18n/localization';

// Re-evaluate calendar dates when the view is checked, including after midnight.
@Pipe({ name: 'messageDate', pure: false })
export class MessageDatePipe implements PipeTransform {
  private readonly localization = inject(Localization);
  private readonly today = translateSignal('messages.date.today');
  private readonly yesterday = translateSignal('messages.date.yesterday');

  transform(value: string | Date | number | null | undefined, format: 'date' | 'dateTime' = 'date'): string {
    if (value == null || value === '') return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const locale = this.localization.locale();
    const label =
      date.toDateString() === now.toDateString()
        ? this.today()
        : date.toDateString() === yesterday.toDateString()
          ? this.yesterday()
          : formatLocalDate(date, locale, date.getFullYear() === now.getFullYear() ? 'monthDay' : 'date');
    return format === 'dateTime' ? `${label} ${formatLocalDate(date, locale, 'time')}` : label;
  }
}
