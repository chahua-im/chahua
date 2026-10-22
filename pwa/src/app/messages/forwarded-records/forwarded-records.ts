import {
  afterNextRender,
  afterRenderEffect,
  viewChild,
  viewChildren,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToolbar,
  IonSpinner,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { documentTextOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { SavedMessagesService } from '../../../generated/endpoints/saved-messages/saved-messages.service';
import { ServerWsMessageType, type ForwardedMessagesResponse, type MessagePreview } from '../../../generated/models';
import { Connection, ResyncReason } from '../../api/connection';
import { ChatChangeKind, ChatStore } from '../../chats/chat-store';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { AvatarColor, AvatarTextPipe } from '../../chats/avatar-text.pipe';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { scrollActivity } from '../../scrolling/scroll-activity';
import { LoadError } from '../../ui/load-error/load-error';
import { LocalDatePipe } from '../../i18n/local-date.pipe';
import { Message, type MessageContent } from '../message/message';
import { messageRows } from '../../conversations/message-rows';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { VoicePlayback } from '../voice-player/voice-playback';

@Component({
  selector: 'app-forwarded-records',
  templateUrl: './forwarded-records.html',
  styleUrls: ['../../conversations/conversation-header.scss', '../../conversations/sticky-avatar.scss'],
  host: { class: 'ion-page' },
  imports: [
    Message,
    AvatarColor,
    AvatarTextPipe,
    ContentScrollbars,
    LoadError,
    TranslocoPipe,
    LocalDatePipe,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonTitle,
    IonToolbar,
    IonSpinner,
  ],
  styles: `
    .sticky-avatar {
      display: grid;
      place-items: center;
      pointer-events: none;
    }
    .records-icon {
      font-size: 24px;
      flex-shrink: 0;
    }
    .redacted {
      margin: 4px 50px;
      color: var(--ion-color-medium);
      font-size: var(--app-font-compact);
    }
  `,
})
export class ForwardedRecords {
  private readonly content = viewChild(IonContent);
  private readonly messageList = viewChild<ElementRef<HTMLElement>>('messageList');
  private readonly messageElements = viewChildren(Message, { read: ElementRef<HTMLElement> });
  private readonly floatingDate = viewChild.required<ElementRef<HTMLElement>>('floatingDate');
  private readonly dateSeparators = viewChildren<ElementRef<HTMLElement>>('dateSeparator');
  protected readonly scrolling = scrollActivity();
  protected readonly visibleDate = signal<string | undefined>(undefined);
  protected readonly dateColliding = signal(false);
  protected readonly hiddenDateRow = signal<number | undefined>(undefined);
  protected readonly stickySender = signal<MessageContent['sender'] | undefined>(undefined);
  protected readonly stickyRow = signal<number | undefined>(undefined);
  protected readonly stickyOffset = signal(0);
  protected readonly recordsIcon = documentTextOutline;
  readonly chatId = input<SnowflakeID | undefined, string | undefined>(undefined, {
    alias: 'id',
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  readonly messageId = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  readonly savedId = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  readonly bundleId = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  private readonly chats = inject(ChatsService);
  private readonly saved = inject(SavedMessagesService);
  private readonly router = inject(Router);
  protected readonly session = inject(SessionStore);
  protected readonly preferences = inject(Preferences);
  private readonly playback = inject(VoicePlayback);
  private readonly connection = inject(Connection);
  private readonly metadata = inject(ChatStore);
  private readonly owner = computed(() => this.session.user()?.uid);
  private readonly active = signal(true);
  private dirty = false;
  private version = 0;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly data = signal<ForwardedMessagesResponse | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly unavailable = signal(false);
  private readonly messages = computed(
    () =>
      this.data()?.messages.map((message) => {
        const reply = message.reply;
        const preview = reply?.kind === 'internal' ? reply.preview : undefined;
        const quote: Omit<MessagePreview, 'clientGeneratedId'> | undefined = preview
          ? {
              ...preview,
              id: preview.originalMessageId,
              createdAt: preview.originalCreatedAt,
              isDeleted: false,
              mentions: preview.mentions ?? [],
            }
          : undefined;
        const content: MessageContent = {
          ...message,
          id: message.originalMessageId,
          chatId: message.originalChatId,
          createdAt: message.originalCreatedAt,
          replyToMessage: quote,
        };
        return { ...content, redacted: reply?.kind === 'redacted' };
      }) ?? [],
  );
  protected readonly rows = computed(() => messageRows(this.messages()));
  protected readonly backHref = computed(() => {
    const root =
      this.savedId() != null
        ? `/chats/saved/${decodeId(this.savedId()!)}/forwarded`
        : `/chats/chat/${decodeId(this.chatId()!)}/message/${decodeId(this.messageId()!)}/forwarded`;
    if (this.bundleId() != null) return root;
    return this.savedId() != null
      ? '/chats/saved'
      : `/chats/chat/${decodeId(this.chatId()!)}#msg=${decodeId(this.messageId()!)}`;
  });
  constructor() {
    afterNextRender(() => void this.observeResize());
    afterRenderEffect(() => {
      this.rows();
      this.preferences.showAllAvatars();
      this.messageElements();
      if (this.active()) untracked(() => void this.trackScroll());
    });
    effect(() => {
      this.chatId();
      this.messageId();
      this.savedId();
      this.bundleId();
      this.owner();
      untracked(() => {
        this.version++;
        this.data.set(undefined);
        this.loading.set(false);
        void this.load();
      });
    });
    effect((onCleanup) => {
      const chatId = this.chatId();
      if (this.active() && this.savedId() == null && chatId != null)
        onCleanup(this.metadata.watchReadStates([{ chatId }]));
    });
    this.connection.changes$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (this.savedId() != null || event.payload.chatId !== this.chatId()) return;
      if (
        (event.type === ServerWsMessageType.messageDeleted && event.payload.id === this.messageId()) ||
        (event.type === ServerWsMessageType.messagesBulkDeleted && event.payload.messageIds.includes(this.messageId()!))
      )
        this.invalidate();
    });
    this.metadata.changes$.pipe(takeUntilDestroyed()).subscribe((change) => {
      if (
        this.savedId() == null &&
        change.kind === ChatChangeKind.Removed &&
        change.chatId === this.chatId() &&
        change.threadId == null
      )
        this.invalidate();
    });
    this.connection.resync$.pipe(takeUntilDestroyed()).subscribe((reason) => {
      if (reason === ResyncReason.Foreground && this.connection.connected() && !this.failed()) return;
      this.dirty = true;
      if (this.active()) this.refresh();
    });
  }
  ionViewWillEnter() {
    this.active.set(true);
    if (this.dirty) this.refresh();
  }
  ionViewWillLeave() {
    this.active.set(false);
    this.scrolling.reset();
    this.playback.pause();
  }
  private invalidate() {
    this.version++;
    this.data.set(undefined);
    this.loading.set(false);
    this.unavailable.set(true);
    this.failed.set(true);
    if (this.active()) this.playback.pause();
  }
  private refresh() {
    this.version++;
    this.loading.set(false);
    void this.load();
  }
  protected async load() {
    if (this.loading()) return;
    this.dirty = false;
    const version = this.version;
    this.loading.set(true);
    this.failed.set(false);
    this.unavailable.set(false);
    try {
      const savedId = this.savedId();
      const bundleId = this.bundleId();
      const request =
        savedId != null
          ? bundleId != null
            ? this.saved.getSavedForwardedBundleMessages(savedId, bundleId)
            : this.saved.getSavedForwardedMessages(savedId)
          : bundleId != null
            ? this.chats.getForwardedBundleMessages(this.chatId()!, this.messageId()!, bundleId)
            : this.chats.getForwardedMessages(this.chatId()!, this.messageId()!);
      const data = await firstValueFrom(request.pipe(takeUntilDestroyed(this.destroyRef)));
      if (!this.destroyRef.destroyed && version === this.version) this.data.set(data);
    } catch (error) {
      if (!this.destroyRef.destroyed && version === this.version) {
        const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        if (status === 403 || status === 404 || status === 410) this.invalidate();
        else this.failed.set(true);
      }
    } finally {
      if (!this.destroyRef.destroyed && version === this.version) this.loading.set(false);
    }
  }
  private async observeResize() {
    const scroll = await this.content()?.getScrollElement();
    if (!scroll || this.destroyRef.destroyed) return;
    const resize = new ResizeObserver(() => void this.trackScroll());
    resize.observe(scroll);
    resize.observe(this.messageList()!.nativeElement);
    this.destroyRef.onDestroy(() => resize.disconnect());
  }
  protected async trackScroll() {
    const scroll = await this.content()?.getScrollElement();
    if (!scroll || this.destroyRef.destroyed || !this.active()) return;
    const viewport = scroll.getBoundingClientRect();
    const elements = this.messageElements();
    const rows = this.rows();
    let low = 0,
      high = elements.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (elements[middle].nativeElement.getBoundingClientRect().bottom < viewport.bottom) low = middle + 1;
      else high = middle;
    }
    const row = rows[low];
    const element = elements[low]?.nativeElement;
    const bubble = element?.querySelector('.bubble, .sticker-content')?.getBoundingClientRect();
    const avatar = element?.querySelector('.avatar')?.getBoundingClientRect();
    const sticky =
      !this.preferences.showAllAvatars() &&
      row &&
      bubble &&
      bubble.top < viewport.bottom &&
      (!avatar || avatar.bottom > viewport.bottom);
    this.stickySender.set(sticky ? row.message.sender : undefined);
    this.stickyRow.set(sticky ? low : undefined);
    this.stickyOffset.set(sticky && row.first ? Math.max(0, bubble.top + 34 - viewport.bottom) : 0);

    let first = 0,
      last = elements.length - 1;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (elements[middle].nativeElement.getBoundingClientRect().bottom <= viewport.top) first = middle + 1;
      else last = middle;
    }
    this.visibleDate.set(rows[first]?.message.createdAt);
    const floating = this.floatingDate().nativeElement;
    const floatingTop = viewport.top + floating.offsetTop;
    const floatingBottom = floatingTop + floating.offsetHeight;
    const overlapMargin = 1;
    const dates = this.dateSeparators();
    let dateLow = 0,
      dateHigh = dates.length;
    while (dateLow < dateHigh) {
      const middle = (dateLow + dateHigh) >>> 1;
      if (dates[middle].nativeElement.getBoundingClientRect().bottom < floatingTop - overlapMargin)
        dateLow = middle + 1;
      else dateHigh = middle;
    }
    const nextDate = dates[dateLow]?.nativeElement.getBoundingClientRect();
    this.dateColliding.set(!!nextDate && nextDate.top <= floatingBottom + overlapMargin);
    let dateRow = first;
    while (dateRow > 0 && !rows[dateRow]?.dateBreak) dateRow--;
    this.hiddenDateRow.set(dateRow);
  }
  protected jump(id: SnowflakeID) {
    this.host.nativeElement
      .querySelector(`[data-message-id="${decodeId(id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  protected child(bundleId: SnowflakeID) {
    const root =
      this.savedId() != null
        ? ['/chats/saved', decodeId(this.savedId()!), 'forwarded']
        : ['/chats/chat', decodeId(this.chatId()!), 'message', decodeId(this.messageId()!), 'forwarded'];
    void this.router.navigate([...root, decodeId(bundleId)]);
  }
}
