import { describe, expect, it } from 'vitest';
import { extractEmojiSequences } from './emoji-sequences';

describe('extractEmojiSequences', () => {
  it('keeps compound emoji intact and in input order', () => {
    expect(extractEmojiSequences('text 👨‍👩‍👧‍👦 👩🏽‍💻 🇨🇳 1️⃣ 👍🏿 ❤️ end')).toEqual(['👨‍👩‍👧‍👦', '👩🏽‍💻', '🇨🇳', '1️⃣', '👍🏿', '❤️']);
  });

  it('drops plain text, digits, and text-presentation symbols', () => {
    expect(extractEmojiSequences('abc 中文 123 # * ❤')).toEqual([]);
  });

  it('preserves duplicates and matches across repeated edits', () => {
    expect(extractEmojiSequences('👍abc❤️👍')).toEqual(['👍', '❤️', '👍']);
    expect(extractEmojiSequences('')).toEqual([]);
    expect(extractEmojiSequences('🇨🇳👍')).toEqual(['🇨🇳', '👍']);
  });
});
