import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { SessionStore } from '../../session/session-store';
import { type MentionInfo } from '../../../generated/models';
import { extractMentionWidgets } from '../../markdown/mentions';
import { hasMarkdownText } from '../../markdown/detect';
import { markdownEngine } from '../../markdown/engine';
import { MarkdownBody } from '../../markdown/markdown-body';
import { renderMarkdownTokens } from '../../markdown/nodes';
import type { MarkdownNode } from '../../markdown/nodes';
import { tokensContainBlocks } from '../../markdown/tokens';

export interface TextPart {
  text: string;
  uid?: number;
  url?: string;
  internal?: string;
}

const INTERNAL_PATH = /^(?:\/$|\/(?:landing|media)$|\/(?:chats|profile|settings)(?:\/|$)|\/(?:m|stickers|sticker)\/)/;

/** Only same-origin app pages use client-side routing; resources remain normal links. */
export function internalHrefFrom(parsed: URL): string | undefined {
  const internal = parsed.origin === location.origin && INTERNAL_PATH.test(parsed.pathname);
  return internal ? parsed.pathname + parsed.search + parsed.hash : undefined;
}

export function internalHref(url: string): string | undefined {
  try {
    return internalHrefFrom(new URL(url));
  } catch {
    return undefined;
  }
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
      const internal = internalHrefFrom(parsed);
      parts.push({ text: url, url, internal: internal ? internal : undefined });
      if (url.length < match[0].length) parts.push({ text: match[0].slice(url.length) });
    }
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}

export interface PreparedMessageContent {
  /** True when the body was rendered with Markdown; nodes is then non-null. */
  isMarkdown: boolean;
  /** True when Markdown produced block structure (list/quote/code/multi-paragraph). */
  hasBlocks: boolean;
  /** The rendered body when Markdown, otherwise null (use the legacy renderer). */
  nodes: MarkdownNode[] | null;
}

/**
 * One-shot Markdown analysis and rendering for a text message — the token list
 * from a single parse is shared between the decision and the render.
 */
export function prepareMessageContent(
  message: string,
  mentions: readonly MentionInfo[],
  currentUserUid: number | null | undefined,
  interactive: boolean,
): PreparedMessageContent {
  const extraction = extractMentionWidgets(message);
  const tokens = markdownEngine.parse(extraction.body, {});
  if (!hasMarkdownText(message, tokens)) {
    return { isMarkdown: false, hasBlocks: false, nodes: null };
  }

  const names = new Map(mentions.map((m) => [m.uid, m.username]));
  const nodes = renderMarkdownTokens(tokens, {
    onPlaceholder: (index) => {
      const widget = extraction.widgets[index];
      if (!widget) return undefined;
      return {
        type: 'mention',
        uid: widget.uid,
        name: names.get(widget.uid) || 'User ' + widget.uid,
        self: currentUserUid != null && widget.uid === currentUserUid,
        clickable: interactive,
      };
    },
    renderLink: (href, label): MarkdownNode => {
      if (!interactive) return { type: 'element', tag: 'span', children: label };
      const internal = internalHref(href);
      return internal
        ? { type: 'element', tag: 'a', attrs: { href, internal }, children: label }
        : { type: 'element', tag: 'a', attrs: { href, target: '_blank', rel: 'noopener noreferrer' }, children: label };
    },
  });
  return { isMarkdown: true, hasBlocks: tokensContainBlocks(tokens), nodes };
}

@Component({
  selector: 'app-message-text',
  templateUrl: './message-text.html',
  host: {
    '[class.blocks]': 'prepared().hasBlocks',
  },
  styleUrl: '../../markdown/mention.scss',
  styles: `
    :host {
      overflow-wrap: anywhere;
    }
    :host(.blocks) {
      display: block;
    }
    a {
      color: var(--message-link-color, var(--ion-color-primary));
      font: inherit;
      padding: 0;
      background: none;
    }
  `,
  imports: [MarkdownBody],
})
export class MessageText {
  readonly text = input('');
  readonly mentions = input<readonly MentionInfo[]>([]);
  readonly interactive = input(true);
  protected readonly currentUserUid = computed(() => this.session.user()?.uid);
  protected readonly parts = computed(() => messageParts(this.text(), this.mentions()));
  protected readonly prepared = computed(() =>
    prepareMessageContent(this.text(), this.mentions(), this.currentUserUid(), this.interactive()),
  );
  private readonly router = inject(Router);
  private readonly session = inject(SessionStore);
  protected follow(url: string, event: MouseEvent) {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void this.router.navigateByUrl(url);
  }
  protected followMarkdown(url: string) {
    void this.router.navigateByUrl(url);
  }
  protected async profile(uid: number, event?: Event) {
    event?.stopPropagation();
    await this.router.navigate(['/profile', uid]);
  }
}
