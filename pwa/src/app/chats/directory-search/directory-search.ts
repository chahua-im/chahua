import { ChatAvatar } from '../chat-avatar/chat-avatar';
import { Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import { Router } from '@angular/router';
import { IonButton, IonItem, IonLabel, IonList, IonListHeader, IonSpinner } from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import {
  GroupSearchMode,
  GroupSelectorScope,
  type GroupSelectorItem,
  type MemberSummary,
  type SnowflakeID,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { LoadError } from '../../ui/load-error/load-error';
import { SessionStore } from '../../session/session-store';
import { InviteCard, type InviteCardResult } from '../../messages/invite-card/invite-card';
import { inviteCode, invitePreviewIssue, InvitePreviewIssue } from '../invite';

interface InviteSearchResult extends InviteCardResult {
  code: string;
}
@Component({
  selector: 'app-directory-search',
  templateUrl: './directory-search.html',
  styleUrl: './directory-search.scss',
  imports: [
    ChatAvatar,
    InviteCard,
    LoadError,
    IonItem,
    IonList,
    IonLabel,
    IonButton,
    IonSpinner,
    IonListHeader,
    TranslocoPipe,
  ],
})
export class DirectorySearch {
  readonly query = input('');
  readonly usersOnly = input(false);
  private readonly api = inject(RpcApi);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly session = inject(SessionStore);
  protected readonly groups = signal<GroupSelectorItem[]>([]);
  protected readonly people = signal<MemberSummary[]>([]);
  protected readonly invitation = signal<InviteSearchResult | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly loadingMore = signal(false);
  private readonly groupsError = signal(false);
  private readonly peopleError = signal(false);
  private readonly invitationError = signal(false);
  protected readonly error = computed(() => this.groupsError() || this.peopleError() || this.invitationError());
  protected readonly cursor = signal<SnowflakeID | undefined>(undefined);
  private version = 0;
  private previous?: { q: string; usersOnly: boolean; uid?: number };
  constructor() {
    effect(() => {
      this.query();
      this.usersOnly();
      void this.search();
    });
  }
  protected async search(more = false) {
    const q = this.query().trim();
    const usersOnly = this.usersOnly();
    const uid = this.session.user()?.uid;
    const version = ++this.version;
    if (!this.previous || q !== this.previous.q || usersOnly !== this.previous.usersOnly || uid !== this.previous.uid) {
      this.groups.set([]);
      this.people.set([]);
      this.invitation.set(undefined);
      this.cursor.set(undefined);
    }
    this.previous = { q, usersOnly, uid };
    this.groupsError.set(false);
    if (!more) {
      this.peopleError.set(false);
      this.invitationError.set(false);
    }
    this.loading.set(!!q && uid != null);
    this.loadingMore.set(more && !!q && uid != null);
    if (!q || uid == null) return;
    const current = () => version === this.version && !this.destroy.destroyed;
    const code = usersOnly || more ? '' : inviteCode(q);
    const isLink = !!code && code !== q;
    // Generated codes have 8–12 characters; links carry an explicit invitation intent.
    const lookupInvite = !!code && (isLink || /^[a-zA-Z0-9]{8,12}$/.test(code));
    const [groups, people, invitation] = await Promise.allSettled([
      usersOnly
        ? Promise.resolve(undefined)
        : firstValueFrom(
            this.api.groups
              .list({
                q,
                mode: GroupSearchMode.submitted,
                scope: GroupSelectorScope.joined,
                limit: 40,
                after: more ? this.cursor() : undefined,
              })
              .pipe(takeUntilDestroyed(this.destroy)),
          ).then((page) => {
            if (!current()) return;
            this.groups.update((items) => (more ? [...items, ...page.groups] : page.groups));
            this.cursor.set(page.nextCursor);
          }),
      more
        ? Promise.resolve(undefined)
        : firstValueFrom(this.api.users.search({ q, limit: 40 }).pipe(takeUntilDestroyed(this.destroy))).then(
            (page) => {
              if (current()) this.people.set(page.members);
            },
          ),
      lookupInvite
        ? firstValueFrom(this.api.invites.getByCode({ inviteCode: code }).pipe(takeUntilDestroyed(this.destroy))).then(
            (preview) => {
              if (current()) this.invitation.set({ code, preview });
            },
            (error: unknown) => {
              if (!current()) return;
              const issue = invitePreviewIssue(error);
              if (issue === InvitePreviewIssue.Inactive) {
                this.invitation.set({ code, issue });
              } else if (issue === InvitePreviewIssue.Missing || issue === InvitePreviewIssue.Invalid) {
                this.invitation.set(isLink ? { code, issue: InvitePreviewIssue.Missing } : undefined);
              } else {
                throw error;
              }
            },
          )
        : Promise.resolve(undefined),
    ]);
    if (!current()) return;
    this.groupsError.set(groups.status === 'rejected');
    if (!more) {
      this.peopleError.set(people.status === 'rejected');
      this.invitationError.set(invitation.status === 'rejected');
    }
    this.loading.set(false);
    this.loadingMore.set(false);
  }
  protected openInvite(code: string) {
    void this.router.navigate(['/chats/join', code]);
  }
  protected openChat(id: SnowflakeID) {
    void this.router.navigate(['/chats/chat', decodeId(id)]);
  }
  protected async profile(user: MemberSummary) {
    await this.router.navigate(['/profile', user.uid]);
  }
}
