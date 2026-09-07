import { ChatDatePipe } from './chat-date.pipe';

const day = 24 * 60 * 60 * 1000;
const now = new Date(2026, 8, 7, 12);

describe('ChatDatePipe', () => {
  const pipe = new ChatDatePipe();
  const local = (date: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, options).format(date);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => vi.useRealTimers());

  it('shows today using a 24-hour clock, even after eight hours', () => {
    expect(pipe.transform(new Date(2026, 8, 7, 0, 5).toISOString())).toBe('00:05');
  });

  it('shows yesterday as a time only while less than eight hours old, including across years', () => {
    vi.setSystemTime(new Date(2027, 0, 1, 6));
    const date = new Date(2026, 11, 31, 23);
    expect(pipe.transform(date.toISOString())).toBe('23:00');
    vi.setSystemTime(new Date(2027, 0, 1, 7));
    expect(pipe.transform(date.toISOString())).toBe(local(date, { weekday: 'short' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses calendar days for the weekday cutoff, including across years', () => {
    vi.setSystemTime(new Date(2027, 0, 3, 12));
    const recent = new Date(2026, 11, 28, 0);
    const older = new Date(2026, 11, 27, 23, 59);
    expect(pipe.transform(recent.toISOString())).toBe(local(recent, { weekday: 'short' }));
    expect(pipe.transform(older.toISOString())).toBe(local(older, { month: '2-digit', day: '2-digit' }));
  });

  it.each([
    [365 * day - 1, { month: '2-digit', day: '2-digit' }],
    [365 * day, { dateStyle: 'short' }],
  ] satisfies [number, Intl.DateTimeFormatOptions][])(
    'uses the local date format at elapsed time %i',
    (age, options) => {
      const date = new Date(now.getTime() - age);
      expect(pipe.transform(date.toISOString())).toBe(local(date, options));
    },
  );

  it('renders an absent date as empty', () => {
    expect(pipe.transform(undefined)).toBe('');
  });
});
