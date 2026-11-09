import { computed, inject, Service } from '@angular/core';
import type { Emoji, SkinTone } from '@nicematic/emoji-picker';
import { AccountStorage, AccountStore } from '../../storage/account-storage';
import type { RecentEmoji } from '../../storage/account-database';

/** Keep the picker's existing ten-entry, three-day frequency decay. */
@Service()
export class PickerRecents {
  private readonly storage = inject(AccountStorage);
  private readonly entries = computed(() => {
    const stored = this.storage.read(AccountStore.Usage, 'emojiRecents', []);
    return rankRecents(stored);
  });
  readonly recents = computed(() =>
    this.entries().map(({ count, lastUsed, keywords, ...emoji }) => ({ ...emoji, keywords: [...keywords] })),
  );

  addRecent(emoji: Emoji) {
    const entries = this.entries();
    const previous = entries.find((entry) => entry.char === emoji.char);
    this.storage.set(
      AccountStore.Usage,
      'emojiRecents',
      rankRecents([
        ...entries.filter((entry) => entry.char !== emoji.char),
        { ...emoji, count: (previous?.count ?? 0) + 1, lastUsed: Date.now() },
      ]),
    );
  }

  clearRecents() {
    this.storage.set(AccountStore.Usage, 'emojiRecents', []);
  }
}

function rankRecents(entries: readonly RecentEmoji[]) {
  const now = Date.now();
  const score = (entry: RecentEmoji) => entry.count * 2 ** (-(now - entry.lastUsed) / (3 * 24 * 60 * 60 * 1000));
  return [...entries].sort((a, b) => score(b) - score(a)).slice(0, 10);
}

@Service()
export class PickerSkinTone {
  private readonly storage = inject(AccountStorage);
  readonly currentSkinTone = computed(() => {
    const tone = this.storage.read(AccountStore.Preferences, 'skinTone', '');
    return ['', '🏻', '🏼', '🏽', '🏾', '🏿'].includes(tone) ? tone : '';
  });

  setSkinTone(tone: SkinTone) {
    this.storage.set(AccountStore.Preferences, 'skinTone', tone);
  }
}
