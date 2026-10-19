import { Component, computed, input } from '@angular/core';
import type { MentionInfo } from '../../../generated/models';
import { findCodeRegions } from '../../markdown/code-regions';
import { MarkdownBody } from '../../markdown/markdown-body';
import { messageHasMarkdown } from '../../markdown/detect';
import { renderMarkdownPreview } from '../../markdown/preview';
import type { MarkdownNode } from '../../markdown/nodes';
import { MessageText } from '../message-text/message-text';

/** Replaces mention macros outside code regions with their display names. */
export function resolveMentionNames(text: string, mentions: readonly MentionInfo[]): string {
  const names = new Map(mentions.map((m) => [m.uid, m.username]));
  const regions = findCodeRegions(text);
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(/@\[uid:(\d+)\]/g)) {
    if (regions.some((region) => match.index! >= region.start && match.index! < region.end)) continue;
    const uid = Number(match[1]);
    result += text.slice(cursor, match.index) + '@' + (names.get(uid) || 'User ' + uid);
    cursor = match.index! + match[0].length;
  }
  return result + text.slice(cursor);
}

/**
 * Single-line summary for chat-list / thread / reply / pin previews. Markdown
 * text renders inline-flattened; otherwise the exact legacy plain text is
 * shown. Long text is clipped by the parent's single-line CSS instead of
 * slicing raw text mid-marker.
 */
@Component({
  selector: 'app-markdown-summary',
  imports: [MarkdownBody, MessageText],
  template: `
    @if (nodes(); as nodes) {
      <app-markdown-body [nodes]="nodes" [summary]="true" />
    } @else {
      <app-message-text [text]="text()" [mentions]="mentions()" [interactive]="false" />
    }
  `,
})
export class MarkdownSummary {
  readonly text = input.required<string>();
  readonly mentions = input<readonly MentionInfo[]>([]);

  protected readonly nodes = computed<MarkdownNode[] | undefined>(() => {
    const text = resolveMentionNames(this.text(), this.mentions());
    if (!messageHasMarkdown(text)) return undefined;
    return renderMarkdownPreview(text);
  });
}
