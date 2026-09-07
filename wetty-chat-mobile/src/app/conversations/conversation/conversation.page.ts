import { DraftStore } from '../draft-store';
import { scrollActivity } from '../scroll-activity';
import { Preferences } from '../../settings/preferences';
import { DatePipe, DOCUMENT } from '@angular/common';
import {
  afterRenderEffect,
  Component,
  ChangeDetectorRef,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonFab,
  IonFabButton,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonSpinner,
  IonTextarea,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { arrowDown, closeCircle, listOutline, send } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import {
  GroupKind,
  MessageType,
  ServerWsMessageType,
  type CreateMessageBody,
  type MessageResponse,
} from '../../../generated/models';
import { ThreadsService } from '../../../generated/endpoints/threads/threads.service';
import { Message } from '../../messages/message/message';
import { MessageMenu } from '../../messages/message-menu/message-menu';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { ConversationNavigation, ConversationTargetKind, type ConversationTarget } from '../conversation-navigation';
import { ChatListStore } from '../../chats/chat-list-store';
import { ChatStore } from '../../chats/chat-store';
import { Connection } from '../../api/connection';
import { SessionStore } from '../../session/session-store';
import { ConversationStore, PageDirection, ConversationError } from '../conversation-store';
import { messageRows } from '../message-rows';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';

function queryMessageId(id: string | undefined) {
  return id && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n ? encodeId(id) : undefined;
}

const enum PositionKind {
  Bottom,
  Unread,
  Message,
  Anchor,
}

export enum ThreadError {
  Load = 1,
  Update,
}

type ScrollPosition =
  | { type: PositionKind.Bottom }
  | { type: PositionKind.Unread }
  | { type: PositionKind.Message; messageId: SnowflakeID }
  | { type: PositionKind.Anchor; messageId: SnowflakeID; offset: number };

@Component({
  selector: 'app-conversation',
  templateUrl: './conversation.page.html',
  styleUrl: './conversation.page.scss',
  providers: [ConversationStore],
  imports: [
    DatePipe,
    RouterLink,
    Message,
    MessageMenu,
    MessagePreview,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonFab,
    IonFabButton,
    IonFooter,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonSpinner,
    IonTextarea,
    IonText,
    IonTitle,
    IonToolbar,
  ],
})
export class ConversationPage {
  protected readonly PageDirection = PageDirection;
  protected readonly ConversationTargetKind = ConversationTargetKind;
  protected readonly ConversationError = ConversationError;
  protected readonly ThreadError = ThreadError;
  private readonly lists = inject(ChatListStore);
  protected readonly session = inject(SessionStore);
  protected readonly preferences = inject(Preferences);
  protected readonly conversation = inject(ConversationStore);
  private readonly chatInfo = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly drafts = inject(DraftStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly api = inject(ChatsService);
  private readonly threadsApi = inject(ThreadsService);
  private readonly realtime = inject(Connection);
  private readonly navigation = inject(ConversationNavigation);
  private readonly document = inject(DOCUMENT);
  private readonly content = viewChild(IonContent);
  private readonly composer = viewChild(IonTextarea);
  private readonly unreadSeparator = viewChild<ElementRef<HTMLElement>>('unreadSeparator');
  protected readonly menu = viewChild(MessageMenu);
  private readonly messages = viewChildren(Message);
  private readonly messageElements = viewChildren(Message, { read: ElementRef<HTMLElement> });
  readonly id = input.required<SnowflakeID, string>({ transform: encodeId });
  readonly threadId = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  readonly message = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: queryMessageId,
  });
  readonly reply = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: queryMessageId,
  });
  private readonly entryVersion = signal(0);
  private readonly entryKey = computed(() => ({
    chatId: this.id(),
    threadId: this.threadId(),
    version: this.entryVersion(),
  }));
  protected readonly chatTitle = computed(() => {
    const chat = this.chatInfo.get(this.id());
    const isDm = chat?.kind === GroupKind.dm;
    return { name: isDm ? chat.peer?.username : chat?.name, isDm };
  });
  protected readonly backHref = computed(() => (this.threadId() ? `/chats/chat/${decodeId(this.id())}` : '/chats'));
  protected readonly subscription = computed(() => {
    const threadId = this.threadId();
    return threadId ? this.lists.subscription(this.id(), threadId) : undefined;
  });
  protected readonly threadBusy = linkedSignal({ source: this.entryKey, computation: () => false });
  protected readonly threadError = linkedSignal({
    source: this.entryKey,
    computation: (): ThreadError | undefined => undefined,
  });
  protected readonly rows = computed(() => messageRows(this.conversation.items()));
  protected readonly scrolling = scrollActivity();
  private readonly active = signal(false);
  private entered = false;
  private navigationVersion = 0;
  private subscriptionVersion = 0;
  private releaseReadState?: () => void;
  private retryAction = () => {};
  private readonly position = signal<ScrollPosition | undefined>(undefined);
  private readonly entryReadId = signal<SnowflakeID | undefined>(undefined);
  protected readonly firstUnreadId = computed(() => {
    const boundary = this.entryReadId();
    return boundary ? this.conversation.items().find((message) => message.id > boundary)?.id : undefined;
  });
  protected readonly atBottom = signal(true);
  protected readonly savedReplyId = computed(() => {
    const id = this.drafts.get(this.id(), this.threadId())?.replyTo;
    return id ? encodeId(id) : undefined;
  });
  protected readonly draft = linkedSignal({ source: this.entryKey, computation: () => '' });
  protected readonly replyTo = linkedSignal({
    source: this.entryKey,
    computation: (): MessageResponse | undefined => undefined,
  });
  protected readonly sendError = linkedSignal({ source: this.entryKey, computation: () => false });
  protected readonly sending = linkedSignal({ source: this.entryKey, computation: () => false });
  protected readonly sendIcon = send;
  protected readonly closeIcon = closeCircle;
  protected readonly downIcon = arrowDown;
  protected readonly listIcon = listOutline;
  protected readonly visiblePins = computed(() =>
    this.conversation
      .pins()
      .filter((pin) => !pin.message.isDeleted)
      .sort((a, b) => b.message.id - a.message.id),
  );
  protected readonly selectedPinId = linkedSignal({
    source: this.visiblePins,
    computation: (pins, previous): SnowflakeID | undefined =>
      pins.find((pin) => pin.id === previous?.value)?.id ?? pins[0]?.id,
  });
  protected readonly selectedPin = computed(() => this.visiblePins().find((pin) => pin.id === this.selectedPinId()));
  protected readonly selectedPinIndex = computed(() =>
    this.visiblePins().findIndex((pin) => pin.id === this.selectedPinId()),
  );
  protected readonly pinsFailed = linkedSignal({ source: this.entryKey, computation: () => false });

  protected async loadPins() {
    const entry = this.entryKey();
    try {
      await this.conversation.ensurePins();
      if (this.isCurrent(entry)) this.pinsFailed.set(false);
    } catch {
      if (this.isCurrent(entry)) this.pinsFailed.set(true);
    }
  }

  protected async locatePin() {
    const pin = this.selectedPin();
    if (!pin || this.pendingNavigation()) return;
    const entry = this.entryKey();
    await this.goTo({ type: ConversationTargetKind.Message, messageId: pin.message.id });
    if (!this.isCurrent(entry) || this.conversation.error()) return;
    const pins = this.visiblePins();
    const index = pins.findIndex((item) => item.id === pin.id);
    this.selectedPinId.set(pins[(index + 1) % pins.length]?.id);
  }

  protected readonly pinsHref = computed(
    () => `/chats/chat/${decodeId(this.id())}${this.threadId() ? `/thread/${decodeId(this.threadId()!)}` : ''}/pins`,
  );
  private readonly clientGeneratedId = linkedSignal({
    source: () => [this.entryKey(), this.draft(), this.replyTo()?.id ?? this.savedReplyId()],
    computation: () => crypto.randomUUID(),
  });

  constructor() {
    effect(() => {
      const id = this.id();
      const threadId = this.threadId();
      untracked(() => this.activate(id, threadId));
    });
    effect(() => {
      const replyId = this.reply();
      const messageId = replyId ?? this.message();
      this.entryKey();
      if (messageId && this.active())
        untracked(() => void this.goTo({ type: ConversationTargetKind.Message, messageId }, !!replyId));
    });
    effect(() => {
      const { threadId } = this.entryKey();
      if (this.active() && threadId && this.subscription() === undefined) untracked(() => void this.loadSubscription());
    });
    this.realtime.messages$.pipe(takeUntilDestroyed()).subscribe((message) => {
      if (!this.isCurrent() || !this.conversation.accepts(message)) return;
      const follow = this.atBottom() && this.conversation.atLatest() && !this.position();
      this.conversation.receive(message);
      if (follow) this.position.set({ type: PositionKind.Bottom });
    });
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (!this.isCurrent()) return;
      if (
        event.type === ServerWsMessageType.threadMembershipChanged &&
        event.payload.chatId === this.id() &&
        event.payload.threadRootId === this.threadId()
      ) {
        void this.loadSubscription();
      }
    });
    this.realtime.resync$.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.isCurrent()) {
        const entry = this.entryKey();
        void this.conversation.reconnect();
        void this.loadPins();
        void this.refreshConversationMetadata()
          .catch(() => {})
          .then(() => {
            if (this.isCurrent(entry)) void this.trackScroll();
          });
      }
    });
    this.navigation.requests$.pipe(takeUntilDestroyed()).subscribe(({ chatId, target, threadId }) => {
      if (this.isCurrent() && chatId === this.id() && threadId === this.threadId()) void this.goTo(target);
    });
    afterRenderEffect(() => {
      this.messageElements();
      this.position();
      if (this.active()) void this.positionAndRead();
    });
    this.destroyRef.onDestroy(() => this.leave());
  }

  private activate(id: SnowflakeID, threadId?: SnowflakeID) {
    this.scrolling.reset();
    this.entryVersion.update((version) => version + 1);
    this.releaseReadState?.();
    this.releaseReadState = threadId ? undefined : this.lists.retainReadState(id);
    this.active.set(true);
    const draft = this.drafts.get(id, threadId);
    this.draft.set(draft?.text ?? '');
    if (draft?.replyTo && !this.reply()) void this.restoreReply(encodeId(draft.replyTo));
    this.conversation.reset(id, threadId);
    void this.loadPins();
    this.entryReadId.set(undefined);
    this.atBottom.set(false);
    this.position.set(undefined);
    void this.chatInfo.ensure(id).catch(() => {});
    if (!this.message() && !this.reply()) void this.goTo({ type: ConversationTargetKind.Resume });
  }

  ionViewWillEnter() {
    if (!this.active()) this.activate(this.id(), this.threadId());
  }

  ionViewDidEnter() {
    this.entered = true;
    void this.positionAndRead();
  }

  ionViewDidLeave() {
    // Only release after a completed transition: an iOS back gesture can be cancelled.
    this.leave();
    // Ionic detaches cached pages; render the cleared state once to release message components.
    this.changeDetector.detectChanges();
  }

  private isCurrent(entry = this.entryKey()) {
    const threadId = this.threadId();
    return (
      entry === this.entryKey() &&
      this.active() &&
      this.router.isActive(`/chats/chat/${decodeId(this.id())}${threadId ? `/thread/${decodeId(threadId)}` : ''}`, {
        paths: 'exact',
        queryParams: 'ignored',
        fragment: 'ignored',
        matrixParams: 'ignored',
      })
    );
  }

  private leave() {
    this.scrolling.reset();
    this.active.set(false);
    this.entryVersion.update((version) => version + 1);
    this.entered = false;
    this.navigationVersion++;
    this.releaseReadState?.();
    this.releaseReadState = undefined;
    this.position.set(undefined);
    this.conversation.reset();
    this.menu()?.reset();
    this.rows();
    this.draft.set('');
    this.replyTo.set(undefined);
  }

  protected readonly pendingNavigation = linkedSignal({
    source: this.entryKey,
    computation: (): ConversationTarget | undefined => undefined,
  });
  protected readonly jumpingTo = computed(() => {
    const target = this.pendingNavigation();
    return target?.type === ConversationTargetKind.Message ? target.messageId : undefined;
  });

  protected async goTo(target: ConversationTarget, replying = false) {
    const entry = this.entryKey();
    const version = ++this.navigationVersion;
    this.pendingNavigation.set(target);
    try {
      this.retryAction = () => void this.goTo(target, replying);
      this.position.set(undefined);
      let around: SnowflakeID | undefined;
      if (target.type === ConversationTargetKind.Resume) {
        const { chatId, threadId } = entry;
        if (threadId) {
          const read =
            this.lists.threadReadState(chatId, threadId) ??
            (await firstValueFrom(
              this.threadsApi.getThreadReadStateInChat(chatId, threadId).pipe(takeUntilDestroyed(this.destroyRef)),
            ).catch(() => undefined));
          around = read?.lastReadMessageId ?? threadId;
        } else {
          const read =
            this.lists.cachedReadState(chatId) ?? (await this.lists.getReadState(chatId).catch(() => undefined));
          around = read?.unreadCount ? read.lastReadMessageId : undefined;
        }
        if (entry !== this.entryKey() || version !== this.navigationVersion) return;
        this.entryReadId.set(around);
      } else if (target.type === ConversationTargetKind.Message) {
        around = target.messageId;
      }
      const loaded = await this.conversation.open(around, target.type === ConversationTargetKind.Message);
      if (!loaded || entry !== this.entryKey() || version !== this.navigationVersion) return;
      const messageId =
        target.type === ConversationTargetKind.Message
          ? target.messageId
          : target.type === ConversationTargetKind.Resume
            ? this.firstUnreadId()
            : undefined;
      this.position.set(
        messageId
          ? target.type === ConversationTargetKind.Message
            ? { type: PositionKind.Message, messageId }
            : { type: PositionKind.Unread }
          : { type: PositionKind.Bottom },
      );
      if (replying && messageId) {
        const message = this.conversation.items().find((item) => item.id === messageId);
        if (message) this.startReply(message);
      }
    } finally {
      if (entry === this.entryKey() && version === this.navigationVersion) this.pendingNavigation.set(undefined);
    }
  }

  protected retry() {
    this.retryAction();
  }

  private async positionAndRead() {
    const entry = this.entryKey();
    const version = this.navigationVersion;
    const scroll = await this.content()?.getScrollElement();
    if (!scroll || !this.isCurrent(entry) || version !== this.navigationVersion) return;
    const position = this.position();
    if (position) {
      if (position.type === PositionKind.Bottom) {
        scroll.scrollTop = scroll.scrollHeight;
      } else if (position.type === PositionKind.Unread) {
        const separator = this.unreadSeparator()?.nativeElement;
        if (separator) {
          const top = scroll.scrollTop + separator.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
          scroll.scrollTop = Math.max(0, Math.min(top, scroll.scrollHeight - scroll.clientHeight));
        }
      } else {
        const index = this.messages().findIndex((message) => message.message().id === position.messageId);
        const element = this.messageElements()[index]?.nativeElement;
        if (element) {
          const rect = element.getBoundingClientRect();
          const edge = position.type === PositionKind.Anchor ? rect.bottom : rect.top;
          const inset =
            position.type === PositionKind.Anchor
              ? position.offset
              : Math.max(0, (scroll.clientHeight - element.offsetHeight) / 2);
          scroll.scrollTop += edge - scroll.getBoundingClientRect().top - inset;
          if (position.type === PositionKind.Message)
            element.animate(
              [{ backgroundColor: 'var(--ion-color-primary-tint)' }, { backgroundColor: 'transparent' }],
              { duration: 1200 },
            );
        }
      }
      this.position.set(undefined);
    }
    await this.trackScroll();
  }

  private async trackScroll() {
    const entry = this.entryKey();
    const version = this.navigationVersion;
    const scroll = await this.content()?.getScrollElement();
    if (!scroll || !this.isCurrent(entry) || version !== this.navigationVersion) return;
    this.atBottom.set(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80);
    if (!this.entered || this.document.hidden || this.conversation.loading() || this.position()) return;
    const elements = this.messageElements();
    const viewport = scroll.getBoundingClientRect();
    // Message bottoms are ordered, so finding the last visible bottom needs only log(n) layout reads.
    let low = 0;
    let high = elements.length - 1;
    let visible = -1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (elements[mid].nativeElement.getBoundingClientRect().bottom <= viewport.bottom) {
        visible = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    const element = elements[visible]?.nativeElement;
    const messageId = this.messages()[visible]?.message().id;
    if (element && messageId && element.getBoundingClientRect().bottom > viewport.top) {
      const threadId = this.threadId();
      void (
        threadId ? this.lists.markThreadRead(this.id(), threadId, messageId) : this.lists.markRead(this.id(), messageId)
      ).catch(() => {});
    }
  }

  protected async onScroll() {
    const entry = this.entryKey();
    const version = this.navigationVersion;
    await this.trackScroll();
    if (!this.isCurrent(entry) || version !== this.navigationVersion || !this.entered || this.position()) return;
    const scroll = await this.content()?.getScrollElement();
    if (!scroll || !this.isCurrent(entry) || version !== this.navigationVersion) return;
    const threshold = scroll.clientHeight * 1.5;
    const above = Math.max(0, scroll.scrollTop);
    const below = Math.max(0, scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight);
    const older = this.conversation.canLoad(PageDirection.Older) && above < threshold;
    const newer = this.conversation.canLoad(PageDirection.Newer) && below < threshold;
    if (older && (!newer || above < below)) void this.loadPage(PageDirection.Older);
    else if (newer) void this.loadPage(PageDirection.Newer);
  }

  protected async loadPage(direction: PageDirection) {
    if (!this.conversation.canLoad(direction)) return;
    const entry = this.entryKey();
    this.retryAction = () => void this.loadPage(direction);
    const version = this.navigationVersion;
    const scroll = await this.content()?.getScrollElement();
    if (!this.isCurrent(entry) || version !== this.navigationVersion) return;
    await this.conversation.load(direction, async () => {
      if (direction !== PageDirection.Older || !scroll) return;
      await this.scrolling.wait();
      if (!this.isCurrent(entry) || version !== this.navigationVersion) return;
      const top = scroll.getBoundingClientRect().top;
      const index = this.messageElements().findIndex(
        ({ nativeElement }) => nativeElement.getBoundingClientRect().bottom > top,
      );
      const element = this.messageElements()[index]?.nativeElement;
      if (element)
        this.position.set({
          type: PositionKind.Anchor,
          messageId: this.messages()[index].message().id,
          // Prepending can remove this message's author header; preserve the content below it.
          offset: element.getBoundingClientRect().bottom - top,
        });
    });
  }

  protected updateDraft(text: string) {
    this.draft.set(text);
    this.drafts.save(this.id(), this.threadId(), text, this.replyTo()?.id ?? this.savedReplyId());
  }

  protected cancelReply() {
    this.replyTo.set(undefined);
    this.drafts.save(this.id(), this.threadId(), this.draft());
  }

  private async restoreReply(messageId: SnowflakeID) {
    const entry = this.entryKey();
    try {
      const message = await firstValueFrom(
        this.api.getMessage(entry.chatId, messageId).pipe(takeUntilDestroyed(this.destroyRef)),
      );
      if (this.isCurrent(entry) && this.savedReplyId() === messageId && !this.replyTo() && !this.sending()) {
        if (message.isDeleted) {
          this.cancelReply();
        } else {
          this.replyTo.set(message);
        }
      }
    } catch {
      // Keep the text usable if the original reply is no longer available.
    }
  }

  protected async sendMessage() {
    const text = this.draft().trim();
    if (!text) return;
    const chatId = this.id();
    const threadId = this.threadId();
    const entry = this.entryKey();
    const savedDraft = this.drafts.get(chatId, threadId);
    this.sending.set(true);
    this.sendError.set(false);
    try {
      const body: CreateMessageBody = {
        message: text,
        messageType: MessageType.text,
        clientGeneratedId: this.clientGeneratedId(),
        replyToId: this.replyTo()?.id ?? this.savedReplyId(),
      };
      const message = await firstValueFrom(
        (threadId ? this.api.postThreadMessage(chatId, threadId, body) : this.api.postMessage(chatId, body)).pipe(
          takeUntilDestroyed(this.destroyRef),
        ),
      );
      if (this.destroyRef.destroyed) return;
      this.realtime.accept(message);
      if (this.drafts.get(chatId, threadId) === savedDraft) this.drafts.clear(chatId, threadId);
      if (this.isCurrent(entry)) {
        this.draft.set('');
        this.replyTo.set(undefined);
        await this.goTo({ type: ConversationTargetKind.Latest });
      }
    } catch {
      if (this.isCurrent(entry)) this.sendError.set(true);
    } finally {
      if (this.isCurrent(entry)) this.sending.set(false);
    }
  }

  private async refreshConversationMetadata() {
    await Promise.all([
      this.chatInfo.ensure(this.id()),
      this.threadId() ? this.loadSubscription() : this.lists.getReadState(this.id()),
    ]);
  }

  protected async loadSubscription() {
    const threadId = this.threadId();
    if (!threadId || this.threadBusy()) return;
    const entry = this.entryKey();
    const version = ++this.subscriptionVersion;
    this.threadBusy.set(true);
    this.threadError.set(undefined);
    try {
      await this.lists.loadSubscription(this.id(), threadId);
    } catch {
      if (this.isCurrent(entry) && version === this.subscriptionVersion) this.threadError.set(ThreadError.Load);
    } finally {
      if (this.isCurrent(entry) && version === this.subscriptionVersion) this.threadBusy.set(false);
    }
  }

  protected async updateThread() {
    const threadId = this.threadId();
    const status = this.subscription();
    if (!threadId || !status || this.threadBusy()) return;
    const entry = this.entryKey();
    this.subscriptionVersion++;
    this.threadBusy.set(true);
    this.threadError.set(undefined);
    try {
      if (status.subscribed) await this.lists.setThreadArchived(this.id(), threadId, !status.archived);
      else await this.lists.subscribeThread(this.id(), threadId);
    } catch {
      if (this.isCurrent(entry)) this.threadError.set(ThreadError.Update);
    } finally {
      if (this.isCurrent(entry)) this.threadBusy.set(false);
    }
  }

  protected openThread(rootId: SnowflakeID) {
    void this.router.navigate(['/chats/chat', decodeId(this.id()), 'thread', decodeId(rootId)]);
  }

  protected startReply(message: MessageResponse) {
    if (this.sending()) return;
    this.replyTo.set(message);
    this.updateDraft(this.draft());
    if (this.atBottom()) this.position.set({ type: PositionKind.Bottom });
    void this.composer()?.setFocus();
  }
}
