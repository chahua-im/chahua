import { inviteCode } from './invite';

describe('inviteCode', () => {
  it.each([
    [' abc123 ', 'abc123'],
    ['https://example.com/chats/join/abc123', 'abc123'],
    ['/chats/join/abc123', 'abc123'],
    ['https://example.com/chats/join/abc123?invite=other', 'abc123'],
    ['https://example.com/landing?invite=abc123', ''],
    ['?invite=abc123', ''],
    ['https://example.com/other/abc123', ''],
    ['', ''],
  ])('extracts only a code or an invitation path from %s', (value, expected) => {
    expect(inviteCode(value)).toBe(expected);
  });
});
