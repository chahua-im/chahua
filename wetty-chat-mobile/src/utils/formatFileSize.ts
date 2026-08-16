const UNITS = ['bytes', 'KiB', 'MiB', 'GiB'] as const;

/** Format a byte count with binary units and the active locale's number formatting. */
export function formatFileSize(bytes: number, locale?: string): string {
  const safeBytes = Math.max(0, bytes);
  let value = safeBytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const maximumFractionDigits = Number.isInteger(value) ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value)} ${UNITS[unit]}`;
}
