import { messageParts } from '../message-text/message-text';
import { displayText, editText, wireText, type EditableText } from './mention-text';

const span = (start: number, end: number, uid = 7): EditableText => ({
  text: '',
  mentions: [{ start, end, uid }],
});

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

describe('relocateMentions via editText', () => {
  const previous = (text: string, start: number, end: number, uid = 7): EditableText => ({
    text,
    mentions: [{ start, end, uid }],
  });

  it('keeps a span unchanged when text is appended after it', () => {
    expect(editText(previous('@devuser2', 0, 9), '@devuser2!').mentions).toEqual([{ start: 0, end: 9, uid: 7 }]);
  });

  it('shifts a span forward when characters are inserted before it', () => {
    expect(editText(previous('Hi @devuser2', 3, 12), 'Hi *@devuser2').mentions).toEqual([
      { start: 4, end: 13, uid: 7 },
    ]);
  });

  it('shifts a span backward when text before it is deleted', () => {
    expect(editText(previous('Hi @devuser2 world', 3, 12), '@devuser2 world').mentions).toEqual([
      { start: 0, end: 9, uid: 7 },
    ]);
  });

  it('re-locates a span wrapped in bold/italic/strike markers', () => {
    const base = previous('@devuser2 ', 0, 9);
    expect(editText(base, '**@devuser2** ').mentions).toEqual([{ start: 2, end: 11, uid: 7 }]);
    expect(editText(base, '*@devuser2* ').mentions).toEqual([{ start: 1, end: 10, uid: 7 }]);
    expect(editText(base, '~~@devuser2~~ ').mentions).toEqual([{ start: 2, end: 11, uid: 7 }]);
  });

  it('re-locates a span when a marker is inserted only before it', () => {
    expect(editText(previous('@devuser2 ', 0, 9), '*@devuser2 ').mentions).toEqual([{ start: 1, end: 10, uid: 7 }]);
  });

  it('drops the span when the mention text itself is edited', () => {
    expect(editText(previous('@devuser2', 0, 9), '@devxuser2').mentions).toEqual([]);
    expect(editText(previous('@devuser2', 0, 9), '@devus').mentions).toEqual([]);
    expect(editText(previous('@devuser2', 0, 9), '@devuserx2').mentions).toEqual([]);
  });

  it('shifts several spans independently across one edit', () => {
    const before: EditableText = {
      text: '@alice see @bob now',
      mentions: [
        { start: 0, end: 6, uid: 1 },
        { start: 11, end: 15, uid: 2 },
      ],
    };
    expect(editText(before, '**@alice** see @bob now').mentions).toEqual([
      { start: 2, end: 8, uid: 1 },
      { start: 15, end: 19, uid: 2 },
    ]);
  });

  it('returns the same array reference when nothing changed', () => {
    const before = previous('@devuser2', 0, 9);
    expect(editText(before, '@devuser2').mentions).toBe(before.mentions);
  });
});

describe('wireText code regions', () => {
  it('replaces a plain mention with the wire macro', () => {
    expect(wireText({ text: '@devuser2 hello', mentions: [{ start: 0, end: 9, uid: 7 }] })).toBe('@[uid:7] hello');
  });

  it('replaces mentions that sit inside markdown emphasis markers', () => {
    expect(wireText({ ...span(1, 10), text: '*@devuser2* today' })).toBe('*@[uid:7]* today');
    expect(wireText({ ...span(2, 11), text: '**@devuser2** today' })).toBe('**@[uid:7]** today');
    expect(wireText({ ...span(2, 11), text: '~~@devuser2~~ today' })).toBe('~~@[uid:7]~~ today');
    expect(wireText({ ...span(2, 11), text: '__@devuser2__ today' })).toBe('__@[uid:7]__ today');
  });

  it('replaces several mentions in one pass', () => {
    expect(
      wireText({
        text: '@alice and @bob',
        mentions: [
          { start: 0, end: 6, uid: 1 },
          { start: 11, end: 15, uid: 2 },
        ],
      }),
    ).toBe('@[uid:1] and @[uid:2]');
  });

  it('leaves mentions inside code regions verbatim', () => {
    const fenced = '```\n@devuser2\n```';
    expect(wireText({ text: fenced, mentions: [{ start: 4, end: 13, uid: 7 }] })).toBe(fenced);
    const inline = 'run `@devuser2` now';
    expect(wireText({ text: inline, mentions: [{ start: 5, end: 14, uid: 7 }] })).toBe(inline);
  });

  it('keeps leading/trailing whitespace when converting (caller trims after)', () => {
    expect(wireText({ text: '  @devuser2 ', mentions: [{ start: 2, end: 11, uid: 7 }] })).toBe('  @[uid:7] ');
  });

  it('returns the original text when there are no entries', () => {
    expect(wireText({ text: 'plain text', mentions: [] })).toBe('plain text');
  });
});
