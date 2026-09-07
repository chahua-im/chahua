import { Pipe, PipeTransform } from '@angular/core';

const day = 24 * 60 * 60 * 1000;
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' });
const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' });

// Re-evaluate elapsed time when the view is checked, without per-row refresh timers.
@Pipe({ name: 'chatDate', pure: false })
export class ChatDatePipe implements PipeTransform {
  transform(value?: string): string {
    if (!value) return '';
    const date = new Date(value);
    const now = new Date();
    const age = Math.abs(now.getTime() - date.getTime());
    if (age >= 365 * day) return shortDate.format(date);

    // Compare local calendar days, independent of daylight-saving day lengths.
    const calendarDay = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
    const daysAgo = (calendarDay(now) - calendarDay(date)) / day;
    if (daysAgo === 0 || (daysAgo === 1 && age < 8 * 60 * 60 * 1000)) return time.format(date);
    return (daysAgo >= 1 && daysAgo < 7 ? weekday : monthDay).format(date);
  }
}
