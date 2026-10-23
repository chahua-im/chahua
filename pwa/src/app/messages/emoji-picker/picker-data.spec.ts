import sourceEmojis from 'emojibase-data/en/data.json';
import { type SkinTone } from '@nicematic/emoji-picker';
import { describe, expect, it } from 'vitest';
import { extractEmojiSequences } from '../../settings/emoji-sequences';
import { PickerData, PickerSearch } from './picker-data';

describe('complete picker data', () => {
  const data = new PickerData();
  const search = new PickerSearch();
  const byChar = new Map(data.allEmojis().map((emoji) => [emoji.char, emoji]));
  const tones: SkinTone[] = ['', '🏻', '🏼', '🏽', '🏾', '🏿'];
  const canonical = (value: string) => extractEmojiSequences(value).join('');

  it('makes every grouped source emoji and skin variant selectable and searchable by its exact sequence', () => {
    for (const source of sourceEmojis) {
      if (source.group == null) continue;
      const base = byChar.get(canonical(source.emoji));
      expect(base, source.emoji).toBeDefined();
      for (const entry of [source, ...(source.skins ?? [])]) {
        search.query.set(entry.emoji);
        expect(
          search.results().map((emoji) => emoji.char),
          entry.emoji,
        ).toEqual([canonical(entry.emoji)]);
      }
      for (const skin of source.skins ?? []) {
        if (typeof skin.tone === 'number') {
          expect(data.getEmojiWithSkinTone(base!, tones[skin.tone]), skin.emoji).toBe(canonical(skin.emoji));
        } else {
          // The six-choice popover cannot express mixed tones; they remain individual grid entries.
          expect(byChar.get(canonical(skin.emoji))?.hasSkinTone, skin.emoji).toBe(false);
        }
      }
    }
  });

  it('only offers complete sequences accepted by pinned-reaction input validation', () => {
    for (const emoji of data.allEmojis()) {
      expect(extractEmojiSequences(emoji.char), emoji.char).toEqual([emoji.char]);
    }
  });

  it.each([
    ['敬礼', '🫡'],
    ['敬禮', '🫡'],
    ['saluting', '🫡'],
    ['忍住泪水', '🥹'],
    ['宇航员', '🧑‍🚀'],
    ['太空人', '🧑‍🚀'],
    ['中国', '🇨🇳'],
    ['中國', '🇨🇳'],
    ['ROCKET SPACE', '🧑‍🚀'],
    ['☺', '☺️'],
    ['👍️', '👍'],
    ['❤️‍🔥', '❤️‍🔥'],
  ])('finds %s in the complete multilingual dataset', (query, char) => {
    search.query.set(query);
    expect(search.results().map((emoji) => emoji.char)).toContain(char);
  });

  it('clears results and rejects unmatched multiword queries', () => {
    for (const query of ['  ', 'astronaut watermelon', 'not-an-emoji-keyword']) {
      search.query.set(query);
      expect(search.results()).toEqual([]);
    }
  });

  it('keeps mixed-tone sequences intact even when a skin preference is supplied', () => {
    const emoji = byChar.get('🫱🏻‍🫲🏿')!;
    expect(data.getEmojiWithSkinTone(emoji, '🏽')).toBe(emoji.char);
  });
});
