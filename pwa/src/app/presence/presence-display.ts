import { Component, computed, effect, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { SnowflakeID } from '../api/snowflake-id';
import { Presence } from './presence';
import { LocalDatePipe, type LocalDateFormat } from '../i18n/local-date.pipe';

export enum LastSeenKind {
  JustNow = 'justNow',
  Minute = 'minute',
  Minutes = 'minutes',
  Hour = 'hour',
  Hours = 'hours',
  Today = 'today',
  Yesterday = 'yesterday',
  Date = 'date',
}

export function lastSeenDisplay(
  lastSeenAt: string | undefined,
  now: number,
): { kind: LastSeenKind; count?: number; dateFormat?: LocalDateFormat } | undefined {
  if (!lastSeenAt) return undefined;
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const minutes = Math.floor(Math.max(0, now - date.getTime()) / 60_000);
  if (minutes < 1) return { kind: LastSeenKind.JustNow };
  if (minutes < 60) return { kind: minutes === 1 ? LastSeenKind.Minute : LastSeenKind.Minutes, count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 12) return { kind: hours === 1 ? LastSeenKind.Hour : LastSeenKind.Hours, count: hours };
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return { kind: LastSeenKind.Today };
  const dateFormat = date.getFullYear() === today.getFullYear() ? 'monthDay' : 'date';
  today.setDate(today.getDate() - 1);
  return {
    kind: date.toDateString() === today.toDateString() ? LastSeenKind.Yesterday : LastSeenKind.Date,
    dateFormat,
  };
}

@Component({
  selector: 'app-user-presence',
  templateUrl: './presence-display.html',
  styleUrl: './presence-display.scss',
  imports: [TranslocoPipe, LocalDatePipe],
})
export class UserPresenceDisplay {
  readonly uid = input<number>();
  readonly active = input(true);
  private readonly presence = inject(Presence);
  protected readonly state = computed(() => (this.active() ? this.presence.user(this.uid()) : undefined));
  protected readonly loading = computed(() => this.active() && this.presence.userLoading(this.uid()));
  protected readonly showFallback = computed(() => this.active() && this.uid() != null && this.presence.live());
  protected readonly lastSeen = computed(() => lastSeenDisplay(this.state()?.lastSeenAt, this.presence.now()));

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
