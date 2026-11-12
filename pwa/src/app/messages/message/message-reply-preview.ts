import { userColors } from '../user-colors';
import { Component, computed, input } from '@angular/core';
import { type MessagePreview as Quote } from '../../../generated/models';
import { ForwardedLabel } from '../forwarded-label';
import { MessagePreview } from '../message-preview/message-preview';

@Component({
  selector: 'button[appMessageReplyPreview], div[appMessageReplyPreview]',
  imports: [ForwardedLabel, MessagePreview],
  template: `
    <span class="reply-content">
      @if (message().forwardedFromName; as name) {
        <app-forwarded-label [name]="name" />
      } @else {
        <span class="reply-name">{{ name() }}</span>
      }
      <span class="reply-text"><app-message-preview [message]="message()" /></span>
    </span>
  `,
  styles: `
    :host {
      --message-accent-source: light-dark(var(--reply-light), var(--reply-dark));
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      position: relative;
      touch-action: pan-y pinch-zoom;
      width: 100%;
      text-align: start;
      font: inherit;
      font-size: var(--app-font-compact);
      line-height: var(--app-line-compact);
      color: inherit;
      border-inline-start: 3px solid var(--message-accent-stripe);
      min-width: 0;
      overflow: hidden;
      background: var(--message-accent-background);
      padding: 3px 6px;
      border-radius: 4px;
      margin-bottom: 6px;
    }

    .reply-name,
    .reply-text {
      display: block;
      // Keep the full font metrics inside the single-line clipping box.
      line-height: normal;
      min-height: var(--app-line-compact);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .reply-name {
      font-weight: 600;
      color: var(--message-accent);
    }
  `,
  host: {
    class: 'reply-preview',
    '[style.--reply-light]': 'colors().light',
    '[style.--reply-dark]': 'colors().dark',
  },
})
export class MessageReplyPreview {
  readonly message = input.required<Omit<Quote, 'clientGeneratedId'>>();
  readonly name = input.required<string | number>();
  protected readonly colors = computed(() => userColors(String(this.name())));
}
