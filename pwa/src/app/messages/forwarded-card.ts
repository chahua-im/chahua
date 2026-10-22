import { Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ForwardedMessagesPreviewResponse } from '../../generated/models';
import { MessagePreview } from './message-preview/message-preview';

@Component({
  selector: 'app-forwarded-card',
  imports: [TranslocoPipe, MessagePreview],
  template: `<strong>{{ 'messages.forward.records' | transloco }}</strong>
    @if (preview(); as preview) {
      @for (message of preview.messages; track message.originalMessageId) {
        <div class="record">
          <span>{{ message.sender.name ?? message.sender.uid }}: </span><app-message-preview [message]="message" />
        </div>
      }
    }
    <div class="footer">
      <small>
        @if (preview(); as preview) {
          {{ 'messages.forward.count' | transloco: { count: preview.total } }}
        }
      </small>
      <ng-content />
    </div>`,
  styles: `
    :host {
      display: block;
      width: 260px;
      max-width: 100%;
      text-align: start;
    }
    strong {
      display: block;
      margin-bottom: 6px;
    }
    .record {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--forward-muted, var(--ion-color-medium));
      line-height: 1.5;
    }
    .footer {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      border-top: 1px solid var(--ion-color-light-shade);
      margin-top: 6px;
      padding-top: 4px;
    }
    small {
      white-space: nowrap;
      color: var(--forward-muted, var(--ion-color-medium));
    }
  `,
})
export class ForwardedCard {
  readonly preview = input<ForwardedMessagesPreviewResponse>();
}
