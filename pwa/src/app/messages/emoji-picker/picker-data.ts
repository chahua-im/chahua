import { computed, signal } from '@angular/core';
import { type Emoji, EmojiDataService, type EmojiLocale, type SkinTone } from '@nicematic/emoji-picker';
import catalog from './picker-emojis.generated.json';

// The generator maps Unicode groups to the picker's fixed category names.
const pickerEmojis = catalog.emojis as (Emoji & { skins?: string[] })[];

const normalize = (value: string) => value.toLowerCase().replace(/\uFE0F/g, '');
const byChar = new Map<string, Emoji>();
const skinVariants = new Map<string, string[]>();
for (const emoji of pickerEmojis) {
  byChar.set(normalize(emoji.char), emoji);
  if (emoji.skins) {
    skinVariants.set(emoji.char, emoji.skins);
    for (const char of emoji.skins) byChar.set(normalize(char), { ...emoji, char });
  }
}
const searchEntries = pickerEmojis.map((emoji) => ({
  emoji,
  text: normalize([emoji.name, ...emoji.keywords].join(' ')),
}));

/** Scoped to the wrapper; the library's grid and popover resolve this same provider. */
export class PickerData extends EmojiDataService {
  override readonly allEmojis = signal<Emoji[]>(pickerEmojis);

  override getEmojiWithSkinTone(emoji: Emoji, skinTone: SkinTone): string {
    if (!skinTone || !emoji.hasSkinTone) return emoji.char;
    // Look up existing recent entries too: older records may omit their base sequence.
    const base = emoji.base ?? byChar.get(normalize(emoji.char))?.base ?? emoji.char;
    const toneIndex = skinTone.codePointAt(0)! - 0x1f3fb;
    return skinVariants.get(base)?.[toneIndex] ?? emoji.char;
  }
}

/** The library's search service keeps a separate hardcoded dataset, so replace it too. */
export class PickerSearch {
  readonly locale = signal<EmojiLocale>('en');
  readonly query = signal('');
  readonly results = computed(() => {
    const query = normalize(this.query().trim());
    if (!query) return [];
    const exact = byChar.get(query);
    if (exact) return [exact];
    const tokens = query.split(/\s+/);
    return searchEntries.filter(({ text }) => tokens.every((token) => text.includes(token))).map(({ emoji }) => emoji);
  });
}
