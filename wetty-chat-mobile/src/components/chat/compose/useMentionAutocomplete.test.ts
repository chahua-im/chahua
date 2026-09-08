import { describe, expect, it } from 'vitest';
import { mentionEntriesToWire, relocateMentionEntries, type MentionEntry } from './useMentionAutocomplete';

const entry = (start: number, end: number, username = 'devuser2', uid = 7): MentionEntry => ({
  uid,
  username,
  start,
  end,
});

describe('relocateMentionEntries', () => {
  it('keeps an entry unchanged when text is appended after it', () => {
    expect(relocateMentionEntries('@devuser2', [entry(0, 9)], '@devuser2!')).toEqual([entry(0, 9)]);
  });

  it('shifts an entry forward when characters are inserted before it', () => {
    expect(relocateMentionEntries('Hi @devuser2', [entry(3, 12)], 'Hi *@devuser2')).toEqual([entry(4, 13)]);
  });

  it('shifts an entry backward when text before it is deleted', () => {
    expect(relocateMentionEntries('Hi @devuser2 world', [entry(3, 12)], '@devuser2 world')).toEqual([entry(0, 9)]);
  });

  it('re-locates an entry wrapped in bold/italic/strike markers', () => {
    expect(relocateMentionEntries('@devuser2 ', [entry(0, 9)], '**@devuser2** ')).toEqual([entry(2, 11)]);
    expect(relocateMentionEntries('@devuser2 ', [entry(0, 9)], '*@devuser2* ')).toEqual([entry(1, 10)]);
    expect(relocateMentionEntries('@devuser2 ', [entry(0, 9)], '~~@devuser2~~ ')).toEqual([entry(2, 11)]);
  });

  it('re-locates an entry when a marker is inserted only before it', () => {
    expect(relocateMentionEntries('@devuser2 ', [entry(0, 9)], '*@devuser2 ')).toEqual([entry(1, 10)]);
  });

  it('drops the entry when the mention text itself is edited', () => {
    expect(relocateMentionEntries('@devuser2', [entry(0, 9)], '@devxuser2')).toEqual([]);
    expect(relocateMentionEntries('@devuser2', [entry(0, 9)], '@devus')).toEqual([]);
    expect(relocateMentionEntries('@devuser2', [entry(0, 9)], '@devuserx2')).toEqual([]);
  });

  it('shifts several entries independently across one edit', () => {
    const previous = '@alice see @bob now';
    const before: MentionEntry[] = [entry(0, 6, 'alice', 1), entry(11, 15, 'bob', 2)];
    const next = '**@alice** see @bob now';
    expect(relocateMentionEntries(previous, before, next)).toEqual([entry(2, 8, 'alice', 1), entry(15, 19, 'bob', 2)]);
  });

  it('returns the same array reference when nothing changed', () => {
    const before = [entry(0, 9)];
    expect(relocateMentionEntries('@devuser2', before, '@devuser2')).toBe(before);
  });

  it('returns the same array reference when there are no entries', () => {
    expect(relocateMentionEntries('a b', [], 'a * b')).toEqual([]);
  });
});

describe('mentionEntriesToWire', () => {
  it('replaces a plain mention with the wire macro', () => {
    expect(mentionEntriesToWire('@devuser2 hello', [entry(0, 9)])).toBe('@[uid:7] hello');
  });

  it('replaces mentions that sit inside markdown emphasis markers', () => {
    expect(mentionEntriesToWire('*@devuser2* today', [entry(1, 10)])).toBe('*@[uid:7]* today');
    expect(mentionEntriesToWire('**@devuser2** today', [entry(2, 11)])).toBe('**@[uid:7]** today');
    expect(mentionEntriesToWire('~~@devuser2~~ today', [entry(2, 11)])).toBe('~~@[uid:7]~~ today');
    expect(mentionEntriesToWire('__@devuser2__ today', [entry(2, 11)])).toBe('__@[uid:7]__ today');
  });

  it('replaces several mentions in one pass', () => {
    const text = '@alice and @bob';
    const entries = [entry(0, 6, 'alice', 1), entry(11, 15, 'bob', 2)];
    expect(mentionEntriesToWire(text, entries)).toBe('@[uid:1] and @[uid:2]');
  });

  it('leaves mentions inside code regions verbatim', () => {
    const fenced = '```\n@devuser2\n```';
    expect(mentionEntriesToWire(fenced, [entry(4, 13)])).toBe(fenced);
    const inline = 'run `@devuser2` now';
    expect(mentionEntriesToWire(inline, [entry(5, 14)])).toBe(inline);
  });

  it('leaves a mention alone when its offsets no longer match the text', () => {
    expect(mentionEntriesToWire('@devuser2 ', [entry(1, 10)])).toBe('@devuser2 ');
  });

  it('keeps leading/trailing whitespace when converting (caller trims after)', () => {
    expect(mentionEntriesToWire('  @devuser2 ', [entry(2, 11)])).toBe('  @[uid:7] ');
  });

  it('returns the original text when there are no entries', () => {
    expect(mentionEntriesToWire('plain text', [])).toBe('plain text');
  });
});
