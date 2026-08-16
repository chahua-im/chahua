import { describe, expect, it } from 'vitest';
import { formatFileSize } from './formatFileSize';

describe('formatFileSize', () => {
  it('uses binary units and preserves exact integers', () => {
    expect(formatFileSize(1024, 'en')).toBe('1 KiB');
    expect(formatFileSize(1536, 'en')).toBe('1.5 KiB');
    expect(formatFileSize(50 * 1024 * 1024, 'en')).toBe('50 MiB');
  });
});
