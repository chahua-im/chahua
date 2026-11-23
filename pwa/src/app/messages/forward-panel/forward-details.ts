import {
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  computed,
  afterNextRender,
  Injector,
  untracked,
} from '@angular/core';
import { IonModal, IonHeader, IonToolbar, IonTitle, IonButtons, IonContent, IonSpinner } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { first, map, of, type Observable, type Subscription } from 'rxjs';
import { RpcError, RpcErrorCode } from '../../api/rpc-error';
import { RpcApi } from '../../../generated/rpc-api';
import type { SnowflakeID } from '../../../generated/models';
import type { ChatPickerTarget } from '../../chats/chat-picker/chat-picker';
import { ChatStore } from '../../chats/chat-store';
import { SessionStore } from '../../session/session-store';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';
import { ModalButton } from '../../ui/modal-button';
import { messageRows } from '../../conversations/message-rows';
import { forwardedRecordContents } from '../forwarded-records/forwarded-record-content';
import { Message, type MessageContent } from '../message/message';
import { MessageDatePipe } from '../message-date.pipe';

import type { ForwardPreview } from './forward-preview';

interface RecordLocation {
  messageId: SnowflakeID;
  bundleId?: SnowflakeID;
}

type BrowsedMessage = MessageContent & { redacted?: boolean };
interface Frame {
  messages: BrowsedMessage[];
  scrollTop: number;
  location?: RecordLocation;
}

@Component({
  selector: 'app-forward-details',
  imports: [
    IonModal,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonSpinner,
    TranslocoPipe,
    Message,
    MessageDatePipe,
    ContentScrollbars,
    LoadError,
    ModalButton,
  ],
  template: `
    <ion-modal
      class="forward-details-modal"
      [isOpen]="open()"
      [canDismiss]="canDismiss"
      (didPresent)="position()"
      (willDismiss)="dismissing()"
      (didDismiss)="closed.emit()"
    >
      <ng-template>
        <ion-header>
          <ion-toolbar>
            @if (canGoBack()) {
              <ion-buttons slot="start">
                <app-modal-button back (pressed)="back()" />
              </ion-buttons>
            }
            <ion-title>{{
              (forwardPreview() || frames().length > 1 ? 'messages.forward.records' : 'messages.forward.recent')
                | transloco
            }}</ion-title>
            <ion-buttons slot="end">
              <app-modal-button (pressed)="close()" />
            </ion-buttons>
          </ion-toolbar>
        </ion-header>
        <ion-content appScrollbars>
          @if (loading()) {
            <div class="page-loading"><ion-spinner /></div>
          }
          @if (failed()) {
            <app-load-error
              [message]="
                (unavailable() ? 'messages.forward.recordsUnavailable' : 'conversation.loadFailed') | transloco
              "
              [retryable]="!unavailable()"
              (retry)="load(pendingLocation)"
            />
          }
          <div class="message-list" [hidden]="loading() || failed()">
            @for (row of rows(); track row.message.id) {
              @if (row.dateBreak) {
                <p class="message-date">
                  <span>{{ row.message.createdAt | messageDate }}</span>
                </p>
              }
              @if (row.message.redacted) {
                <p class="ion-padding-horizontal">{{ 'messages.forward.redacted' | transloco }}</p>
              }
              <app-message
                [message]="row.message"
                [own]="row.message.sender.uid === session.user()?.uid"
                [first]="row.first"
                [last]="row.last"
                [record]="true"
                [preview]="true"
                [allowPreviewBundle]="!!forwardPreview()"
                [interactive]="false"
                [canReply]="false"
                (bundleOpened)="child(row.message)"
              />
            } @empty {
              @if (!loading() && !failed()) {
                <p class="ion-text-center ion-padding">{{ 'messages.empty' | transloco }}</p>
              }
            }
          </div>
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
  styles: `
    ion-modal {
      --width: min(760px, 100vw);
      --height: min(820px, 90dvh);
    }
    ion-content {
      --background: var(--app-conversation-background);
    }
    @media (max-width: 767px) {
      ion-modal {
        --width: 100%;
        --height: 100%;
        --border-radius: 0;
      }
    }
  `,
})
export class ForwardDetails {
  readonly forwardPreview = input<ForwardPreview>();
  readonly target = input.required<ChatPickerTarget>();
  readonly closed = output<void>();
  readonly sourceUnavailable = output<void>();
  private readonly api = inject(RpcApi);
  private readonly metadata = inject(ChatStore);
  private readonly injector = inject(Injector);
  private readonly modal = viewChild(IonModal);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly session = inject(SessionStore);
  private readonly content = viewChild(IonContent);
  protected readonly open = signal(true);
  protected readonly frames = signal<Frame[]>([]);
  protected readonly rows = computed(() => messageRows(this.frames().at(-1)?.messages ?? []));
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly unavailable = signal(false);
  private readonly chatId = computed(() => this.target().chatId);
  private readonly threadId = computed(() => this.target().threadId);
  private readonly targetAccessible = computed(() =>
    this.forwardPreview()
      ? this.metadata.isAccessible(this.forwardPreview()!.source.chatId)
      : this.metadata.isAccessible(this.chatId(), this.threadId()),
  );
  protected readonly canGoBack = computed(
    () => this.frames().length > 1 || ((this.loading() || this.failed()) && this.frames().length > 0),
  );
  protected readonly canDismiss = (_data?: unknown, role?: string) => {
    if (role === 'close' || role === 'navigate' || role === 'parent-dismissed' || role === 'parent-removed')
      return true;
    if (this.canGoBack()) {
      this.back();
      return false;
    }
    return true;
  };
  protected pendingLocation?: RecordLocation;
  private read?: Subscription;
  constructor() {
    this.destroyRef.onDestroy(() => this.read?.unsubscribe());
    effect(() => {
      if (!this.forwardPreview()) {
        this.chatId();
        this.threadId();
      }
      untracked(() => this.load());
    });
    effect(() => {
      if (this.targetAccessible() || (!this.forwardPreview() && untracked(this.frames).length > 0)) return;
      this.read?.unsubscribe();
      this.frames.set([]);
      this.loading.set(false);
      this.failed.set(true);
      this.unavailable.set(true);
    });
  }
  protected load(location?: RecordLocation) {
    if (!this.open() || !this.targetAccessible()) return;
    this.read?.unsubscribe();
    this.pendingLocation = location;
    this.loading.set(true);
    this.failed.set(false);
    this.unavailable.set(false);

    const preview = this.forwardPreview();
    let loadedLocation = location;
    let records: Observable<BrowsedMessage[]>;
    if (preview?.records && !location) {
      records = of(preview.records);
    } else if (preview) {
      loadedLocation = location ?? { messageId: preview.source.id };
      const { messageId, bundleId } = loadedLocation;
      const chatId = preview.source.chatId;
      const page =
        bundleId == null
          ? this.api.messages.listForwardedMessages({ chatId, messageId })
          : this.api.messages.listForwardedBundleMessages({ chatId, messageId, bundleId });
      records = page.pipe(map(forwardedRecordContents));
    } else {
      const { chatId, threadId } = this.target();
      records = this.api.messages
        .list({ chatId, threadId, max: 20 })
        .pipe(map((page) => [...page.messages].sort((a, b) => a.id - b.id)));
    }
    this.read = records.pipe(first()).subscribe({
      next: (messages) => {
        const frame = { messages, scrollTop: preview ? 0 : -1, location: loadedLocation };
        this.frames.update((frames) => (location == null ? [frame] : [...frames, frame]));
        this.loading.set(false);
        afterNextRender(() => this.position(), { injector: this.injector });
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.failed.set(true);
        this.unavailable.set(
          error instanceof RpcError &&
            [RpcErrorCode.Forbidden, RpcErrorCode.NotFound, RpcErrorCode.Gone].includes(error.code),
        );
        if (this.unavailable()) this.frames.set([]);
        if (preview && this.unavailable()) this.sourceUnavailable.emit();
      },
    });
  }
  protected async child(message: BrowsedMessage) {
    const frame = this.frames().at(-1);
    const parent = frame?.location;
    if (!this.forwardPreview() || this.loading() || message.forwardedBundleId == null || message.id == null) return;
    const location = parent
      ? { messageId: parent.messageId, bundleId: message.forwardedBundleId }
      : { messageId: message.id };
    const element = await this.content()?.getScrollElement();
    if (this.destroyRef.destroyed || !this.open() || frame !== this.frames().at(-1)) return;
    this.frames.update((frames) =>
      frames.map((frame, i) => (i === frames.length - 1 ? { ...frame, scrollTop: element?.scrollTop ?? 0 } : frame)),
    );
    this.load(location);
  }
  protected back() {
    this.read?.unsubscribe();
    const pending = this.loading() || this.failed();
    this.loading.set(false);
    this.failed.set(false);
    this.unavailable.set(false);
    if (!pending) this.frames.update((frames) => frames.slice(0, -1));
    afterNextRender(() => this.position(), { injector: this.injector });
  }
  protected position() {
    const frame = this.frames().at(-1);
    if (!frame || this.loading() || this.failed()) return;
    if (frame.scrollTop < 0) void this.content()?.scrollToBottom(0);
    else void this.content()?.scrollToPoint(undefined, frame.scrollTop, 0);
  }
  protected dismissing() {
    this.open.set(false);
    this.read?.unsubscribe();
  }
  protected close() {
    void this.modal()?.dismiss(undefined, 'close');
  }
}
