import { displayText, editText, wireText } from './mention-text';
import { messageParts } from '../message-text/message-text';
describe('Mention text', () => {
  it('renders the supplied name immediately and leaves a stable fallback without a name', () => {
    expect(
      messageParts('你好 @[uid:2] 和 @[uid:3]', [{ uid: 2, username: '朋友', gender: 0 }])
        .map((p) => p.text)
        .join(''),
    ).toBe('你好 @朋友 和 @User 3');
  });
  it('does not interpret malformed URLs or script links as executable content', () => {
    expect(messageParts('https://[bad javascript:alert(1)').every((p) => !p.url)).toBe(true);
  });
  it('displays names but serializes exact UID tokens', () => {
    const value = displayText('你好 @[uid:2]', new Map([[2, '小明']]));
    expect(value.text).toBe('你好 @小明');
    expect(wireText(value)).toBe('你好 @[uid:2]');
  });
  it('retains mention identity when text is inserted before and after it', () => {
    const value = displayText('@[uid:2] 好', new Map([[2, '小明']]));
    expect(wireText(editText(value, '你好 @小明 好！'))).toBe('你好 @小明 好！');
    expect(wireText(editText(value, '你好 @小明 好'))).toBe('你好 @[uid:2] 好');
    expect(wireText(editText(value, '@小明 好！'))).toBe('@[uid:2] 好！');
  });
  it('turns a partially edited mention into ordinary text', () => {
    expect(wireText(editText(displayText('@[uid:2]', new Map([[2, '小明']])), '@小王'))).toBe('@小王');
  });
  it('keeps identical display names bound to their original different users', () => {
    const value = displayText(
      '@[uid:2] @[uid:3]',
      new Map([
        [2, '小明'],
        [3, '小明'],
      ]),
    );
    expect(wireText(editText(value, value.text + ' 好'))).toBe('@[uid:2] @[uid:3] 好');
  });
});
