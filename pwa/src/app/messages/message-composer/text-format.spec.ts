import { describe, expect, it } from 'vitest';
import { displayText, wireText } from './mention-text';
import { markdownEngine } from '../../markdown/engine';
import { shortcutFormatKind, wrapInlineFormat, type InlineFormatKind } from './text-format';

const formats: { kind: InlineFormatKind; marker: string; tag: string }[] = [
  { kind: 'bold', marker: '**', tag: 'strong' },
  { kind: 'italic', marker: '__', tag: 'em' },
];

describe('formatting shortcuts', () => {
  it.each(formats)('formats a selected word as $kind and restores the cursor', ({ kind, marker, tag }) => {
    const result = wrapInlineFormat('say hello there', { start: 4, end: 9 }, kind)!;
    expect(result.text).toBe(`say ${marker}hello${marker} there`);
    expect(result.selectionStart).toBe(13);
    expect(result.selectionEnd).toBe(13);
    expect(markdownEngine.render(result.text)).toContain(`<${tag}>hello</${tag}>`);
  });

  it.each(formats)('keeps edge whitespace outside $kind markers', ({ kind, marker, tag }) => {
    const text = '  hello \t';
    const result = wrapInlineFormat(text, { start: 0, end: text.length }, kind)!;
    expect(result.text).toBe(`  ${marker}hello${marker} \t`);
    expect(markdownEngine.render(result.text)).toContain(`<${tag}>hello</${tag}>`);
  });

  it.each(formats)('formats separate paragraphs as $kind without consuming blank lines', ({ kind, marker, tag }) => {
    const text = ' first\ncontinued \n \t\n\n second \n\n third ';
    const result = wrapInlineFormat(text, { start: 0, end: text.length }, kind)!;
    expect(result.text).toBe(
      ` ${marker}first\ncontinued${marker} \n \t\n\n ${marker}second${marker} \n\n ${marker}third${marker} `,
    );
    const html = markdownEngine.render(result.text);
    expect(html).toContain(`<${tag}>first<br>\ncontinued</${tag}>`);
    expect(html).toContain(`<${tag}>second</${tag}>`);
    expect(html).toContain(`<${tag}>third</${tag}>`);
    expect(html).not.toContain(marker);
  });

  it('maps mentions exactly across multiple formatted paragraphs and leaves plain names alone', () => {
    const value = displayText(
      'before @[uid:7]\n\n@小明 @[uid:8] after',
      new Map([
        [7, '小明'],
        [8, '小明'],
      ]),
    );
    const result = wrapInlineFormat(value.text, { start: 7, end: value.text.length - 6 }, 'italic', value.mentions)!;
    expect(wireText(result)).toBe('before __@[uid:7]__\n\n__@小明 @[uid:8]__ after');
  });

  it('drops mention identity only when a marker is inserted inside its name', () => {
    const value = displayText(
      '@[uid:7] and @[uid:8]',
      new Map([
        [7, 'Alice'],
        [8, 'Bob'],
      ]),
    );
    const result = wrapInlineFormat(value.text, { start: 2, end: 4 }, 'bold', value.mentions)!;
    expect(wireText(result)).toBe('@A**li**ce and @[uid:8]');
  });

  it('preserves CRLF paragraph separators', () => {
    const text = 'a\r\n\r\nb';
    expect(wrapInlineFormat(text, { start: 0, end: text.length }, 'bold')!.text).toBe('**a**\r\n\r\n**b**');
  });

  it.each(formats)('does not inject $kind markers into empty or whitespace-only selections', ({ kind }) => {
    expect(wrapInlineFormat('abc', { start: 1, end: 1 }, kind)).toBeNull();
    const text = ' \t\n\n ';
    expect(wrapInlineFormat(text, { start: 0, end: text.length }, kind)!.text).toBe(text);
  });

  it('keeps text outside a selection intact', () => {
    expect(wrapInlineFormat('before first\n\nsecond after', { start: 7, end: 20 }, 'italic')!.text).toBe(
      'before __first__\n\n__second__ after',
    );
  });

  it.each(['b', 'B', 'i', 'I'])('recognizes %s', (key) => {
    expect(shortcutFormatKind({ key })).toBe(key.toLowerCase() === 'b' ? 'bold' : 'italic');
  });

  it.each(['d', 'D', 'q', 'Q', 'k', 'Enter'])('does not intercept %s', (key) => {
    expect(shortcutFormatKind({ key })).toBeNull();
  });
});
