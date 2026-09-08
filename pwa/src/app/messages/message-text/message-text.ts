import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { type MentionInfo } from '../../../generated/models';
import { UserProfile } from '../../chats/user-profile/user-profile';

export interface TextPart {
  text: string;
  uid?: number;
  url?: string;
  internal?: string;
}
export function messageParts(text: string, mentions: readonly MentionInfo[] = []): TextPart[] {
  const names = new Map(mentions.map((m) => [m.uid, m.username]));
  const parts: TextPart[] = [];
  let end = 0;
  for (const match of text.matchAll(/@\[uid:(\d+)\]|https?:\/\/[^\s<>]+/g)) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index) });
    if (match[1]) {
      const uid = Number(match[1]);
      parts.push({ text: '@' + (names.get(uid) || 'User ' + uid), uid });
    } else {
      const url = match[0].replace(/[.,!?;:，。！？；：）)]+$/, '');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        parts.push({ text: match[0] });
        end = match.index + match[0].length;
        continue;
      }
      const internal =
        (parsed.origin === location.origin ||
          /(^|\.)(chahua\.im|chahui\.app|shireyishunjian\.com)$/.test(parsed.hostname)) &&
        /^(\/chats(?:\/|$)|\/m\/|\/profile$)/.test(parsed.pathname);
      parts.push({ text: url, url, internal: internal ? parsed.pathname + parsed.search : undefined });
      if (url.length < match[0].length) parts.push({ text: match[0].slice(url.length) });
    }
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}
@Component({
  selector: 'app-message-text',
  templateUrl: './message-text.html',
  styles: `
    :host {
      white-space: inherit;
      overflow-wrap: anywhere;
    }
    a,
    button {
      color: var(--message-link-color, var(--ion-color-primary));
      font: inherit;
      padding: 0;
      background: none;
      text-decoration: none;
    }
    button {
      cursor: pointer;
    }
  `,
  imports: [],
})
export class MessageText {
  readonly text = input('');
  readonly mentions = input<readonly MentionInfo[]>([]);
  readonly interactive = input(true);
  protected readonly parts = computed(() => messageParts(this.text(), this.mentions()));
  private readonly modals = inject(ModalController);
  private readonly router = inject(Router);
  protected follow(url: string, event: MouseEvent) {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    void this.router.navigateByUrl(url);
  }
  protected async profile(uid: number, event: Event) {
    event.stopPropagation();
    const mention = this.mentions().find((m) => m.uid === uid);
    const modal = await this.modals.create({
      component: UserProfile,
      componentProps: { user: mention ?? { uid, gender: 0 } },
    });
    await modal.present();
  }
}
