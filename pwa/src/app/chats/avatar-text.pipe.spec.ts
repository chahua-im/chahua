import { AvatarTextPipe } from './avatar-text.pipe';

const pipe = new AvatarTextPipe();

describe('AvatarTextPipe', () => {
  it.each([
    ['🕊️ 7版鸽舍 🕊️', '🕊️'],
    ['𠮷野', '𠮷'],
    ['🇨🇳茶话', '🇨🇳'],
    ['👩🏽‍💻小茶', '👩🏽‍💻'],
    ['👨‍👩‍👧‍👦家庭', '👨‍👩‍👧‍👦'],
    ['e\u0301clair', 'e\u0301'],
    ['茶话', '茶'],
    ['Alice', 'A'],
  ])('keeps the first visible character intact: %s', (name, expected) => {
    expect(pipe.transform(name)).toBe(expected);
  });

  it('preserves the two-character message avatar without splitting the second emoji', () => {
    expect(pipe.transform('A👩🏽‍💻小茶', 2)).toBe('A👩🏽‍💻');
    expect(pipe.transform('🇨🇳🕊️茶话', 2)).toBe('🇨🇳🕊️');
    expect(pipe.transform('小茶', 2)).toBe('小茶');
  });

  it.each([undefined, null, ''])('leaves a missing name empty: %s', (name) => {
    expect(pipe.transform(name)).toBe('');
  });
});
