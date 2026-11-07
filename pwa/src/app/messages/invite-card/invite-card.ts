import { ChatAvatar } from '../../chats/chat-avatar/chat-avatar';
import { Component, effect, inject, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { IonCard, IonCardHeader, IonCardSubtitle, IonIcon, IonSpinner } from '@ionic/angular';
import { mailOutline, people } from 'ionicons/icons';
import { RpcApi } from '../../../generated/rpc-api';
import type { InvitePreviewResponse } from '../../../generated/models';
import { inviteCode, inviteExpired, invitePreviewIssue, InvitePreviewIssue } from '../../chats/invite';

export interface InviteCardResult {
  preview?: InvitePreviewResponse;
  issue?: InvitePreviewIssue;
}

@Component({
  selector: 'app-invite-card',
  imports: [ChatAvatar, IonCard, IonCardHeader, IonCardSubtitle, IonIcon, IonSpinner, TranslocoPipe],
  templateUrl: './invite-card.html',
  styleUrl: './invite-card.scss',
})
export class InviteCard {
  readonly code = input.required<string>();
  readonly result = input<InviteCardResult>();
  protected readonly defaultAvatarIcon = people;
  protected readonly invitationIcon = mailOutline;
  private readonly api = inject(RpcApi);
  protected readonly preview = signal<InvitePreviewResponse | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly issue = signal<InvitePreviewIssue | undefined>(undefined);
  protected readonly expired = inviteExpired;
  constructor() {
    effect((onCleanup) => {
      const result = this.result();
      if (result) {
        this.preview.set(result.preview);
        this.issue.set(result.issue);
        this.failed.set(false);
        this.loading.set(false);
        return;
      }
      const code = inviteCode(this.code());
      this.loading.set(true);
      this.failed.set(false);
      this.issue.set(undefined);
      this.preview.set(undefined);
      const subscription = this.api.invites.getByCode({ inviteCode: code }).subscribe({
        next: (preview) => {
          this.preview.set(preview);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          const previewIssue = invitePreviewIssue(error);
          const issue =
            previewIssue === InvitePreviewIssue.Invalid
              ? InvitePreviewIssue.Missing
              : previewIssue === InvitePreviewIssue.Restricted
                ? undefined
                : previewIssue;
          this.issue.set(issue);
          this.failed.set(issue == null);
          this.loading.set(false);
        },
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
