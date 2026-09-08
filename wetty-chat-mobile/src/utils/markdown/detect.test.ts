import { describe, expect, it } from 'vitest';

import { messageHasMarkdown } from './detect';

describe('messageHasMarkdown', () => {
  it('rejects empty and plain text', () => {
    expect(messageHasMarkdown('')).toBe(false);
    expect(messageHasMarkdown('hello world')).toBe(false);
    expect(messageHasMarkdown('5 * 3 = 15')).toBe(false);
    expect(messageHasMarkdown('a ~2~ b')).toBe(false);
    expect(messageHasMarkdown('你好世界')).toBe(false);
  });

  it('detects inline emphasis, code, underline and strikethrough', () => {
    expect(messageHasMarkdown('**bold** text')).toBe(true);
    expect(messageHasMarkdown('*italic*')).toBe(true);
    expect(messageHasMarkdown('a ~~strike~~ b')).toBe(true);
    expect(messageHasMarkdown('a __underline__ b')).toBe(true);
    expect(messageHasMarkdown('`inline code`')).toBe(true);
  });

  it('detects explicit links and linkified bare URLs', () => {
    expect(messageHasMarkdown('[label](https://a.b)')).toBe(true);
    expect(messageHasMarkdown('a https://auto.example/path b')).toBe(true);
  });

  it('detects the supported block constructs', () => {
    expect(messageHasMarkdown('> quote')).toBe(true);
    expect(messageHasMarkdown('- item')).toBe(true);
    expect(messageHasMarkdown('1. item')).toBe(true);
    expect(messageHasMarkdown('```\ncode\n```')).toBe(true);
  });

  it('keeps removed syntax literal (single underscore, headings, hr, image)', () => {
    expect(messageHasMarkdown('_underscore em_')).toBe(false);
    expect(messageHasMarkdown('# heading')).toBe(false);
    expect(messageHasMarkdown('---')).toBe(false);
    // A relative target avoids linkify, so the image macro stays pure text.
    expect(messageHasMarkdown('![alt](diagram.png)')).toBe(false);
    expect(messageHasMarkdown('    indented code')).toBe(false);
  });

  it('treats several plain lines as one paragraph', () => {
    expect(messageHasMarkdown('first line\nsecond line')).toBe(false);
  });

  it('counts escaped punctuation as markdown intent', () => {
    expect(messageHasMarkdown('\\*not emphasis\\*')).toBe(true);
    expect(messageHasMarkdown('literal \\[bracket\\]')).toBe(true);
  });

  it('does not flag backslashes in paths or regexes', () => {
    expect(messageHasMarkdown('C:\\path\\to\\file')).toBe(false);
    expect(messageHasMarkdown('\\d+ matches digits')).toBe(false);
    expect(messageHasMarkdown('backslash at end\\')).toBe(false);
  });

  it('ignores mentions and bare words', () => {
    expect(messageHasMarkdown('@[uid:1] hello')).toBe(false);
    expect(messageHasMarkdown('mention @alice here')).toBe(false);
  });
});
