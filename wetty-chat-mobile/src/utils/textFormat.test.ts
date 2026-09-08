import { describe, expect, it } from 'vitest';
import {
  applyLink,
  normalizeLinkHref,
  shortcutFormatKind,
  wrapBlockFormat,
  wrapInlineFormat,
  type TextFormatKind,
} from './textFormat';

describe('wrapInlineFormat', () => {
  const KINDS: Array<{ kind: TextFormatKind; open: string; close: string }> = [
    { kind: 'bold', open: '**', close: '**' },
    { kind: 'italic', open: '*', close: '*' },
    { kind: 'strike', open: '~~', close: '~~' },
    { kind: 'underline', open: '__', close: '__' },
  ];

  it.each(KINDS.map(({ kind, open, close }) => [kind, open, close]))(
    'wraps %s selection and places the cursor after the closing marker',
    (kind, open, close) => {
      const result = wrapInlineFormat('say hello there', { start: 4, end: 9 }, kind as never);

      expect(result).not.toBeNull();
      expect(result!.text).toBe(`say ${open}hello${close} there`);
      const inserted = `${open}hello${close}`;
      expect(result!.selectionStart).toBe(4 + inserted.length);
      expect(result!.selectionEnd).toBe(4 + inserted.length);
    },
  );

  it('returns null for a collapsed selection (no stray markers)', () => {
    expect(wrapInlineFormat('nothing selected', { start: 3, end: 3 }, 'bold')).toBeNull();
    expect(wrapInlineFormat('nothing selected', { start: 3, end: 3 }, 'italic')).toBeNull();
    expect(wrapInlineFormat('nothing selected', { start: 3, end: 3 }, 'strike')).toBeNull();
    expect(wrapInlineFormat('nothing selected', { start: 3, end: 3 }, 'underline')).toBeNull();
  });

  it('clamps out-of-range selections to the text bounds', () => {
    const result = wrapInlineFormat('abc', { start: -5, end: 99 }, 'bold');
    expect(result!.text).toBe('**abc**');
  });

  it('keeps surrounding text intact when wrapping at the edges', () => {
    const whole = wrapInlineFormat('abc', { start: 0, end: 3 }, 'italic');
    expect(whole!.text).toBe('*abc*');
    const prefix = wrapInlineFormat('abc', { start: 0, end: 1 }, 'bold');
    expect(prefix!.text).toBe('**a**bc');
  });
});

describe('wrapBlockFormat', () => {
  it('wraps a selection in fenced code markers', () => {
    const result = wrapBlockFormat('a\nconst x = 1;\nb', { start: 2, end: 14 }, 'code');
    expect(result!.text).toBe('a\n```\nconst x = 1;\n```\nb');
    expect(result!.selectionStart).toBe(result!.selectionEnd);
  });

  it('prefixes every selected line for a quote', () => {
    const result = wrapBlockFormat('first\nsecond', { start: 0, end: 12 }, 'quote');
    expect(result!.text).toBe('> first\n> second');
  });

  it('collapsed selection returns null (no stray prefixes)', () => {
    expect(wrapBlockFormat('abc', { start: 1, end: 1 }, 'code')).toBeNull();
    expect(wrapBlockFormat('abc', { start: 1, end: 1 }, 'quote')).toBeNull();
  });
});

describe('applyLink', () => {
  it('turns a selection into a Markdown link', () => {
    // "docs" spans indexes 9..13 in "open the docs page now".
    const result = applyLink('open the docs page now', { start: 9, end: 13 }, 'example.com');

    expect(result.text).toBe('open the [docs](https://example.com) page now');
    // Cursor collapses after the closing parenthesis.
    expect(result.selectionStart).toBe(9 + '[docs](https://example.com)'.length);
    expect(result.selectionEnd).toBe(result.selectionStart);
  });

  it('inserts the text placeholder and selects it when there is no selection', () => {
    const result = applyLink('hello ', { start: 6, end: 6 }, 'https://example.com');

    expect(result.text).toBe('hello [text](https://example.com)');
    expect(result.selectionStart).toBe(7); // inside the `[text]` label
    expect(result.selectionEnd).toBe(11);
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe('text');
  });

  it('preserves explicit http(s) URLs', () => {
    const result = applyLink('x', { start: 0, end: 1 }, 'HTTP://Example.COM/path?q=1');
    expect(result.text).toBe('[x](HTTP://Example.COM/path?q=1)');
  });

  it('normalises an empty raw URL to https://', () => {
    const result = applyLink('x', { start: 0, end: 1 }, '   ');
    expect(result.text).toBe('[x](https://)');
  });
});

describe('normalizeLinkHref', () => {
  it('prefixes scheme-less input with https://', () => {
    expect(normalizeLinkHref('example.com/path')).toBe('https://example.com/path');
    expect(normalizeLinkHref('  example.com  ')).toBe('https://example.com');
  });

  it('keeps http/https schemes untouched', () => {
    expect(normalizeLinkHref('https://example.com')).toBe('https://example.com');
    expect(normalizeLinkHref('http://example.com')).toBe('http://example.com');
  });

  it('never returns an executable scheme', () => {
    expect(normalizeLinkHref('javascript:alert(1)')).toBe('https://alert(1)');
    expect(normalizeLinkHref('vbscript:msgbox(1)')).toBe('https://msgbox(1)');
    expect(normalizeLinkHref('data:text/html,x')).toBe('https://text/html,x');
  });
});

describe('shortcutFormatKind', () => {
  it('maps Ctrl/Cmd + B / I / D / U / Q to the matching format', () => {
    expect(shortcutFormatKind({ key: 'b' })).toBe('bold');
    expect(shortcutFormatKind({ key: 'B' })).toBe('bold');
    expect(shortcutFormatKind({ key: 'i' })).toBe('italic');
    expect(shortcutFormatKind({ key: 'I' })).toBe('italic');
    expect(shortcutFormatKind({ key: 'd' })).toBe('strike');
    expect(shortcutFormatKind({ key: 'D' })).toBe('strike');
    expect(shortcutFormatKind({ key: 'u' })).toBe('underline');
    expect(shortcutFormatKind({ key: 'U' })).toBe('underline');
    expect(shortcutFormatKind({ key: 'q' })).toBe('quote');
    expect(shortcutFormatKind({ key: 'Q' })).toBe('quote');
  });

  it('returns null for unrelated keys', () => {
    expect(shortcutFormatKind({ key: 'x' })).toBeNull();
    expect(shortcutFormatKind({ key: 'Enter' })).toBeNull();
  });
});
