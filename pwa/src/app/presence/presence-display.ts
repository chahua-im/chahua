import { Component, computed, effect, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { SnowflakeID } from '../api/snowflake-id';
import { Presence } from './presence';

export type LastSeenBucket =
  | 'recently'
  | 'within30m'
  | 'within1h'
  | 'within2h'
  | 'within6h'
  | 'within12h'
  | 'within1day'
  | 'within1week'
  | 'within1month'
  | 'longago';

export function lastSeenBucket(lastSeenAt: string | undefined, now: number): LastSeenBucket | undefined {
  if (!lastSeenAt) return undefined;
  const timestamp = Date.parse(lastSeenAt);
  if (Number.isNaN(timestamp)) return undefined;
  const age = Math.max(0, now - timestamp);
  if (age < 5 * 60_000) return 'recently';
  if (age < 30 * 60_000) return 'within30m';
  if (age < 60 * 60_000) return 'within1h';
  if (age < 2 * 60 * 60_000) return 'within2h';
  if (age < 6 * 60 * 60_000) return 'within6h';
  if (age < 12 * 60 * 60_000) return 'within12h';
  if (age < 24 * 60 * 60_000) return 'within1day';
  if (age < 7 * 24 * 60 * 60_000) return 'within1week';
  if (age < 30 * 24 * 60 * 60_000) return 'within1month';
  return 'longago';
}

@Component({
  selector: 'app-user-presence',
  templateUrl: './presence-display.html',
  styleUrl: './presence-display.scss',
  imports: [TranslocoPipe],
})
export class UserPresenceDisplay {
  readonly uid = input<number>();
  readonly active = input(true);
  private readonly presence = inject(Presence);
  protected readonly state = computed(() => (this.active() ? this.presence.user(this.uid()) : undefined));
  protected readonly loading = computed(() => this.active() && this.presence.userLoading(this.uid()));
  protected readonly bucket = computed(() => lastSeenBucket(this.state()?.lastSeenAt, this.presence.now()));

  constructor() {
    effect((onCleanup) => {
      const uid = this.uid();
      if (!this.active() || uid == null) return;
      onCleanup(this.presence.watch({ userIds: [uid] }));
    });
  }
}

@Component({
  selector: 'app-group-presence',
  templateUrl: './group-presence-display.html',
  styleUrl: './presence-display.scss',
  imports: [TranslocoPipe],
})
export class GroupPresenceDisplay {
  readonly chatId = input<SnowflakeID>();
  readonly active = input(true);
  private readonly presence = inject(Presence);
  protected readonly state = computed(() => (this.active() ? this.presence.group(this.chatId()) : undefined));
  protected readonly loading = computed(() => this.active() && this.presence.groupLoading(this.chatId()));

  constructor() {
    effect((onCleanup) => {
      const chatId = this.chatId();
      if (!this.active() || chatId == null) return;
      onCleanup(this.presence.watch({ chatIds: [chatId] }));
    });
  }
}
