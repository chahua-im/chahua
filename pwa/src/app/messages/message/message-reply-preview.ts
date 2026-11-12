import { Component, input } from '@angular/core';
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
      border-inline-start: 3px solid var(--reply-color);
      min-width: 0;
      overflow: hidden;
      background: color-mix(in srgb, var(--reply-color) 10%, transparent);
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
      color: var(--reply-color);
    }

    :host(.outgoing) .reply-name {
      color: inherit;
    }
    :host(.outgoing) app-forwarded-label {
      --forward-muted: currentColor;
      opacity: 0.75;
    }
    :host(.outgoing:not(.neutral)) {
      border-inline-start-color: color-mix(in srgb, var(--ion-color-primary-contrast) 50%, transparent);
      background: color-mix(in srgb, var(--ion-text-color, #000) 10%, transparent);
    }
  `,
  host: {
    class: 'reply-preview',
    '[class.outgoing]': 'outgoing()',
    '[class.neutral]': 'neutral()',
  },
})
export class MessageReplyPreview {
  readonly message = input.required<Omit<Quote, 'clientGeneratedId'>>();
  readonly name = input.required<string | number>();
  readonly outgoing = input(false);
  readonly neutral = input(false);
}
