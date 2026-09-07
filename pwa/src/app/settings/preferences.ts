import { Service, signal } from '@angular/core';

const THREADS_KEY = 'chahua.preferences.showThreadsInMessages';
const AVATARS_KEY = 'chahua.preferences.showAllAvatars';

@Service()
export class Preferences {
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
