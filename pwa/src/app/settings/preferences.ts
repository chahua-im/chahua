import { Service, signal } from '@angular/core';

const THREADS_KEY = 'chahua.preferences.showThreadsInMessages';
const REACTIONS_KEY = 'chahua.preferences.recentReactions';

const AVATARS_KEY = 'chahua.preferences.showAllAvatars';

@Service()
export class Preferences {
  readonly recentReactions = signal<readonly string[]>(readReactions());
  rememberReaction(emoji: string) {
    this.recentReactions.update((items) => [emoji, ...items.filter((item) => item !== emoji)].slice(0, 5));
    window.localStorage.setItem(REACTIONS_KEY, JSON.stringify(this.recentReactions()));
  }

  private readonly threads = signal(window.localStorage.getItem(THREADS_KEY) !== 'false');
  private readonly avatars = signal(window.localStorage.getItem(AVATARS_KEY) === 'true');
  readonly showThreadsInMessages = this.threads.asReadonly();
  readonly showAllAvatars = this.avatars.asReadonly();

  setShowThreadsInMessages(value: boolean) {
    window.localStorage.setItem(THREADS_KEY, String(value));
    this.threads.set(value);
  }

  setShowAllAvatars(value: boolean) {
    window.localStorage.setItem(AVATARS_KEY, String(value));
    this.avatars.set(value);
  }
}

function readReactions(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(REACTIONS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}
