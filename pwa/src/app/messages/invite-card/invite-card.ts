import { Component, effect, inject, input, signal } from '@angular/core';
import { IonAvatar, IonSpinner } from '@ionic/angular';
import { InvitesService } from '../../../generated/endpoints/invites/invites.service';
import type { InvitePreviewResponse } from '../../../generated/models';
import { inviteCode, inviteStatus, InviteStatus } from '../../chats/invite';
@Component({
  selector: 'app-invite-card',
  imports: [IonAvatar, IonSpinner],
  templateUrl: './invite-card.html',
  styleUrl: './invite-card.scss',
})
export class InviteCard {
  readonly code = input.required<string>();
  private readonly api = inject(InvitesService);
  protected readonly preview = signal<InvitePreviewResponse | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly status = inviteStatus;
  protected readonly Status = InviteStatus;
  constructor() {
    effect((onCleanup) => {
      const code = inviteCode(this.code());
      this.loading.set(true);
      this.failed.set(false);
      this.preview.set(undefined);
      const subscription = this.api.getInviteByCode({ inviteCode: code }).subscribe({
        next: (preview) => {
          this.preview.set(preview);
          this.loading.set(false);
        },
        error: () => {
          this.failed.set(true);
          this.loading.set(false);
        },
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
