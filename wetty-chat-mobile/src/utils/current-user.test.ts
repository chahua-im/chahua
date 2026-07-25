import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentUserId, normalizeCurrentUserId, setCurrentUserId } from './current-user';

const storage = new Map<string, string>();
const sessionStorageMock = {
  clear: () => storage.clear(),
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
};

vi.stubGlobal('window', { sessionStorage: sessionStorageMock });
vi.stubGlobal('sessionStorage', sessionStorageMock);

describe('current user ID storage', () => {
  beforeEach(() => sessionStorage.clear());

  it('accepts only the positive i32 range and whole values', () => {
    expect(normalizeCurrentUserId('1')).toBe(1);
    expect(normalizeCurrentUserId(' 2147483647 ')).toBe(2147483647);
    expect(normalizeCurrentUserId('1suffix')).toBeNull();
    expect(normalizeCurrentUserId('1.5')).toBeNull();
    expect(normalizeCurrentUserId('0')).toBeNull();
    expect(normalizeCurrentUserId('2147483648')).toBeNull();
  });

  it('resets malformed session storage to UID 1', () => {
    sessionStorage.setItem('uid', 'bad');
    expect(getCurrentUserId()).toBe(1);
    expect(sessionStorage.getItem('uid')).toBe('1');
  });

  it('rejects invalid values without storing them', () => {
    expect(() => setCurrentUserId(0)).toThrow(RangeError);
    expect(() => setCurrentUserId(2147483648)).toThrow(RangeError);
    expect(sessionStorage.getItem('uid')).toBeNull();
    setCurrentUserId(42);
    expect(sessionStorage.getItem('uid')).toBe('42');
  });
});
