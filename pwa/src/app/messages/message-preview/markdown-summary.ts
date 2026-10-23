import { Component, computed, input } from '@angular/core';
import type { MentionInfo } from '../../../generated/models';
import { extractMentionWidgets } from '../../markdown/mentions';
import { MarkdownBody } from '../../markdown/markdown-body';
import { messageHasMarkdown } from '../../markdown/detect';
import { renderMarkdownPreview } from '../../markdown/preview';
import type { MarkdownNode } from '../../markdown/nodes';
import { messageParts } from '../message-text/message-text';

/**
 * Single-line summary for chat-list / thread / reply / pin previews. Markdown
 * text renders inline-flattened; plain text replaces line breaks with spaces.
 * Long text is clipped by the parent's single-line CSS instead of
 * slicing raw text mid-marker.
 */
@Component({
  selector: 'app-markdown-summary',
  imports: [MarkdownBody],
  template: `
    @if (nodes(); as nodes) {
      <app-markdown-body [nodes]="nodes" [summary]="true" />
    } @else {
      <ng-container>{{ plainText() }}</ng-container>
    }
  `,
})
export class MarkdownSummary {
  readonly text = input.required<string>();
  readonly mentions = input<readonly MentionInfo[]>([]);

  protected readonly plainText = computed(() =>
    messageParts(this.text(), this.mentions())
      .map((part) => part.text)
      .join('')
      .replace(/\r\n|[\r\n]/g, ' '),
  );

  protected readonly nodes = computed<MarkdownNode[] | undefined>(() => {
    const { body, widgets } = extractMentionWidgets(this.text());
    if (!messageHasMarkdown(body)) return undefined;
    const names = new Map(this.mentions().map((mention) => [mention.uid, mention.username]));
    return renderMarkdownPreview(body, {
      onPlaceholder: (index) => {
        const widget = widgets[index];
        if (!widget) return undefined;
        return { type: 'text', text: '@' + (names.get(widget.uid) || 'User ' + widget.uid) };
      },
      renderLink: (_href, label) => ({ type: 'element', tag: 'span', children: label }),
    });
  });
}
