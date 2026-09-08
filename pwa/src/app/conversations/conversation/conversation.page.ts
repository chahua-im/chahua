import { DatePipe, DOCUMENT } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectorRef,
  Component,
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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonFab,
  IonFabButton,
  IonFooter,
  IonHeader,
  IonIcon,
  IonModal,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import {
  archive,
  archiveOutline,
  chevronDown,
  closeCircleOutline,
  informationCircleOutline,
  listOutline,
  starOutline,
} from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { ChatsService } from '../../../generated/endpoints/chats/chats.service';
import { ThreadsService } from '../../../generated/endpoints/threads/threads.service';
import { GroupKind, MessageType, ServerWsMessageType, type MessageResponse } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { ChatDetails } from '../../chats/chat-details/chat-details';
import { ChatStore } from '../../chats/chat-store';
import { MessageComposer, type Composition } from '../../messages/message-composer/message-composer';
import { MessageMenu } from '../../messages/message-menu/message-menu';
import { MessageOutbox, type OutgoingMessage } from '../../messages/message-outbox';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { Message, type MessageContent } from '../../messages/message/message';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { scrollActivity } from '../../scrolling/scroll-activity';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ConversationNavigation, ConversationTargetKind, type ConversationTarget } from '../conversation-navigation';
import { ConversationError, ConversationStore, PageDirection } from '../conversation-store';
import { DraftStore } from '../draft-store';
import { messageRows } from '../message-rows';

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
  host: {
    '(dragover)': 'composer()?.dragover($event)',
    '(drop)': 'composer()?.drop($event)',
    '(document:visibilitychange)': 'document.hidden && saveDraft()',
    '(window:pagehide)': 'saveDraft()',
  },
  imports: [
    ContentScrollbars,
    DatePipe,
    ChatDetails,
    IonModal,
    RouterLink,
    Message,
    MessageMenu,
    MessageComposer,
    MessagePreview,
    IonBackButton,
    IonBadge,
    IonButton,
    IonButtons,
    IonContent,
    IonFab,
    IonFabButton,
    IonFooter,
    IonHeader,
    IonIcon,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class ConversationPage {
  private readonly wide = window.matchMedia('(min-width: 1200px)');
  protected readonly largeScreen = signal(this.wide.matches);
  protected readonly sidebarOpen = signal(true);
  protected readonly infoOpen = signal(false);
  protected readonly infoIcon = informationCircleOutline;
  protected details() {
    if (this.largeScreen()) this.sidebarOpen.update((open) => !open);
    else this.infoOpen.set(true);
  }
  private readonly editTarget = linkedSignal<MessageResponse | OutgoingMessage | undefined>(() => {
    this.entryKey();
    return undefined;
  });
  protected readonly editing = computed(() => {
    const target = this.editTarget();
    return target && ('delivery' in target ? untracked(target.message) : target);
  });
  protected readonly editingUploads = computed(() => {
    const target = this.editTarget();
    return target && 'delivery' in target ? untracked(() => target.uploads) : [];
  });
  protected startEdit(message: MessageResponse | OutgoingMessage) {
    this.editTarget.set(message);
    this.editText.set(this.editing()?.message ?? '');
    void this.composer()?.setFocus();
  }
  protected editLastMessage() {
    const row = [...this.rows()]
      .reverse()
      .find(
        (row) =>
          row.message.sender.uid === this.session.user()?.uid &&
          !row.message.isDeleted &&
          row.message.messageType === MessageType.text,
      );
    const message = row?.outgoing ?? row?.confirmed;
    if (message) this.startEdit(message);
  }
  protected escapeComposer() {
    if (this.editing()) {
      if (this.editText() === (this.editing()?.message ?? '')) this.cancelEdit();
    } else this.cancelReply();
  }
  protected cancelEdit() {
    this.editTarget.set(undefined);
    this.editText.set('');
  }
  protected readonly PageDirection = PageDirection;
  protected readonly ConversationTargetKind = ConversationTargetKind;
  protected readonly ConversationError = ConversationError;
  protected readonly ThreadError = ThreadError;
  protected readonly session = inject(SessionStore);
  protected readonly preferences = inject(Preferences);
  protected readonly conversation = inject(ConversationStore);
  private readonly chatInfo = inject(ChatStore);
  private readonly router = inject(Router);
  private readonly drafts = inject(DraftStore);
  protected readonly outbox = inject(MessageOutbox);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly api = inject(ChatsService);
  private readonly threadsApi = inject(ThreadsService);
  protected readonly realtime = inject(Connection);
  private readonly navigation = inject(ConversationNavigation);
  protected readonly document = inject(DOCUMENT);
  private readonly content = viewChild(IonContent);
  protected readonly composer = viewChild(MessageComposer);
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
  private readonly loadedThreadRoot = linkedSignal({
    source: this.entryKey,
    computation: (): MessageResponse | undefined => undefined,
  });
  protected readonly threadRoot = computed(() => {
    const rootId = this.threadId();
    return rootId
      ? (this.conversation.items().find((message) => message.id === rootId) ??
          this.chatInfo.thread(rootId)?.threadRootMessage ??
          this.loadedThreadRoot())
      : undefined;
  });
  private async loadThreadRoot() {
    const entry = this.entryKey();
    if (!entry.threadId || this.threadRoot()) return;
    try {
      const root = await firstValueFrom(
        this.api.getMessage(entry.chatId, entry.threadId).pipe(takeUntilDestroyed(this.destroyRef)),
      );
      if (this.isCurrent(entry)) this.loadedThreadRoot.set(root);
    } catch {
      /* The conversation can remain usable when the root is unavailable. */
    }
  }
  protected readonly backHref = computed(() => (this.threadId() ? `/chats/chat/${decodeId(this.id())}` : '/chats'));
  protected readonly subscription = computed(() => {
    const threadId = this.threadId();
    return threadId ? this.chatInfo.subscription(this.id(), threadId) : undefined;
  });
  protected readonly threadBusy = linkedSignal({ source: this.entryKey, computation: () => false });
  protected readonly threadError = linkedSignal({
    source: this.entryKey,
    computation: (): ThreadError | undefined => undefined,
  });
  protected readonly outgoing = computed(() => this.outbox.items().filter((item) => item.chatId === this.id()));
  protected readonly rows = computed(() => {
    const messages = this.conversation.items();
    const known = new Set(messages.map((message) => message.clientGeneratedId));
    const entries: { key: string; message: MessageContent; confirmed?: MessageResponse; outgoing?: OutgoingMessage }[] =
      [];
    for (const message of messages) {
      if (message.isDeleted) continue;
      const outgoing = this.outgoing().find(
        (item) => item.editId === message.id || item.clientGeneratedId === message.clientGeneratedId,
      );
      if (outgoing?.cancelled()) continue;
      const preview = outgoing?.message();
      entries.push({
        key: message.clientGeneratedId || decodeId(message.id),
        message: preview
          ? {
              ...message,
              message: preview.message,
              attachments: preview.attachments,
              mentions: preview.mentions,
              isEdited: preview.isEdited,
            }
          : message,
        confirmed: message,
        outgoing,
      });
    }
    for (const outgoing of this.outgoing()) {
      if (
        outgoing.editId ||
        outgoing.cancelled() ||
        outgoing.threadId !== this.threadId() ||
        known.has(outgoing.clientGeneratedId)
      )
        continue;
      entries.push({ key: outgoing.clientGeneratedId, message: outgoing.message(), outgoing });
    }
    return messageRows(entries.map((entry) => entry.message)).map((row, index) => ({ ...row, ...entries[index] }));
  });
  private readonly peerUid = computed(() => this.chatInfo.get(this.id())?.peer?.uid);
  protected readonly relationship = computed(() => {
    const uid = this.peerUid();
    return uid ? this.chatInfo.relationship(uid).value() : undefined;
  });
  protected readonly scrolling = scrollActivity();
  protected readonly visibleDate = signal<string | undefined>(undefined);
  protected readonly active = signal(false);
  private entered = false;
  private navigationVersion = 0;
  private subscriptionVersion = 0;
  private retryAction = () => {};
  private readonly position = signal<ScrollPosition | undefined>(undefined);
  private readonly entryReadId = signal<SnowflakeID | undefined>(undefined);
  protected readonly firstUnreadId = computed(() => {
    const boundary = this.entryReadId();
    return boundary
      ? this.rows().find(({ confirmed }) => confirmed && confirmed.id > boundary)?.confirmed?.id
      : undefined;
  });
  protected readonly atBottom = signal(true);
  private readonly returnMessageIds = linkedSignal({
    source: this.entryKey,
    computation: (): SnowflakeID[] => [],
  });
  protected readonly showDownButton = computed(
    () => (!this.atBottom() || !!this.conversation.page()?.newerCursor) && !this.composer()?.voiceActive(),
  );
  protected readonly navigatingDown = linkedSignal({ source: this.entryKey, computation: () => false });
  protected readonly unreadCount = computed(() => this.chatInfo.unreadCount(this.id(), this.threadId()));
  protected readonly savedReplyId = linkedSignal({
    source: this.entryVersion,
    computation: (): SnowflakeID | undefined => undefined,
  });
  // Route cleanup saves the previous input before activate advances entryVersion.
  protected readonly draft = linkedSignal({ source: this.entryVersion, computation: () => '' });
  protected readonly editText = linkedSignal({ source: this.entryVersion, computation: () => '' });
  protected readonly replyTo = linkedSignal({
    source: this.entryVersion,
    computation: (): MessageResponse | undefined => undefined,
  });
  protected readonly closeIcon = closeCircleOutline;
  protected readonly downIcon = chevronDown;
  protected readonly listIcon = listOutline;
  protected readonly threadIcons = { starOutline, archiveOutline, archive, informationCircleOutline };
  protected readonly pins = computed(() => this.chatInfo.pins(this.id(), this.threadId()));
  protected readonly visiblePins = computed(() =>
    this.pins()
      .items()
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
      await this.pins().ensure();
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

  constructor() {
    effect((onCleanup) => {
      const uid = this.peerUid();
      if (this.active() && uid && uid !== this.session.user()?.uid)
        onCleanup(this.chatInfo.relationship(uid).activate());
    });
    const resize = () => {
      this.largeScreen.set(this.wide.matches);
      if (this.wide.matches) this.infoOpen.set(false);
    };
    this.wide.addEventListener('change', resize);
    this.destroyRef.onDestroy(() => this.wide.removeEventListener('change', resize));
    effect((onCleanup) => {
      const id = this.id();
      const threadId = this.threadId();
      untracked(() => this.activate(id, threadId));
      onCleanup(() => untracked(() => this.saveDraft({ chatId: id, threadId })));
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
      if (this.active() && threadId && !this.subscription()) untracked(() => void this.loadSubscription());
    });
    this.realtime.messages$.pipe(takeUntilDestroyed()).subscribe((message) => {
      if (!this.isCurrent() || !this.conversation.accepts(message)) return;
      const follow = this.atBottom() && this.conversation.atLatest() && !this.position();
      this.conversation.receive(message);
      if (follow) this.position.set({ type: PositionKind.Bottom });
      else if (!this.threadId()) void this.chatInfo.getReadState(this.id()).catch(() => {});
    });
    this.realtime.events$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (!this.isCurrent()) return;
      if (event.type === ServerWsMessageType.messageUpdated && event.payload.id === this.threadId())
        this.loadedThreadRoot.set(event.payload);
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
    effect(() => {
      const messages = this.conversation.items();
      untracked(() => this.outbox.release(messages));
    });
    effect(() => {
      if (!this.conversation.atLatest()) return;
      const messages = this.outgoing()
        .filter((item) => !item.editId && !item.cancelled() && item.published())
        .map((item) => item.confirmed()!);
      untracked(() => {
        for (const message of messages) this.conversation.receive(message);
      });
    });
    effect(() => {
      const target = this.editTarget();
      if (target && 'delivery' in target && target.cancelled()) untracked(() => this.cancelEdit());
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
    this.active.set(true);
    const draft = this.drafts.get(id, threadId);
    this.draft.set(draft?.text ?? '');
    this.savedReplyId.set(draft?.replyTo ? encodeId(draft.replyTo) : undefined);
    if (draft?.replyTo && !this.reply()) void this.restoreReply(encodeId(draft.replyTo));
    this.conversation.reset(id, threadId);
    void this.loadPins();
    void this.loadThreadRoot();
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

  ionViewWillLeave() {
    this.saveDraft();
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
    this.saveDraft();
    this.scrolling.reset();
    this.active.set(false);
    this.entryVersion.update((version) => version + 1);
    this.entered = false;
    this.navigationVersion++;
    this.position.set(undefined);
    this.conversation.reset();
    this.menu()?.reset();
    this.rows();
    this.draft.set('');
    this.replyTo.set(undefined);
    this.composer()?.reset();
  }

  protected readonly pendingNavigation = linkedSignal({
    source: this.entryKey,
    computation: (): ConversationTarget | undefined => undefined,
  });
  protected readonly jumpingTo = computed(() => {
    const target = this.pendingNavigation();
    return target?.type === ConversationTargetKind.Message ? target.messageId : undefined;
  });

  protected async goTo(target: ConversationTarget, replying = false, fromId?: SnowflakeID) {
    const entry = this.entryKey();
    const version = ++this.navigationVersion;
    this.pendingNavigation.set(target);
    try {
      this.retryAction = () => void this.goTo(target, replying, fromId);
      this.position.set(undefined);
      let around: SnowflakeID | undefined;
      if (target.type === ConversationTargetKind.Resume) {
        const { chatId, threadId } = entry;
        if (threadId) {
          const read =
            this.chatInfo.threadReadState(chatId, threadId) ??
            (await firstValueFrom(
              this.threadsApi.getThreadReadStateInChat(chatId, threadId).pipe(takeUntilDestroyed(this.destroyRef)),
            ).catch(() => undefined));
          around = read?.lastReadMessageId ?? threadId;
        } else {
          const read =
            this.chatInfo.cachedReadState(chatId) ?? (await this.chatInfo.getReadState(chatId).catch(() => undefined));
          around = read?.unreadCount ? read.lastReadMessageId : undefined;
        }
        if (entry !== this.entryKey() || version !== this.navigationVersion) return;
        this.entryReadId.set(around);
      } else if (target.type === ConversationTargetKind.Message) {
        around = target.messageId;
      }
      const loaded = await this.conversation.open(around, target.type === ConversationTargetKind.Message);
      if (!loaded || entry !== this.entryKey() || version !== this.navigationVersion) return;
      if (target.type === ConversationTargetKind.Latest) this.returnMessageIds.set([]);
      else if (target.type === ConversationTargetKind.Message && fromId && fromId > target.messageId) {
        this.returnMessageIds.update((ids) => (ids.at(-1) === fromId ? ids : [...ids, fromId]));
      }
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
      return true;
    } finally {
      if (entry === this.entryKey() && version === this.navigationVersion) this.pendingNavigation.set(undefined);
    }
  }

  protected async navigateDown() {
    if (this.pendingNavigation()) return;
    const entry = this.entryKey();
    const messageId = this.returnMessageIds().at(-1);
    this.navigatingDown.set(true);
    try {
      const reached = await this.goTo(
        messageId ? { type: ConversationTargetKind.Message, messageId } : { type: ConversationTargetKind.Latest },
      );
      if (entry !== this.entryKey()) return;
      // A deleted return target must not trap the button; network failures remain retryable.
      if (messageId && (reached || this.conversation.error() === ConversationError.Missing))
        this.returnMessageIds.update((ids) => ids.filter((id) => id !== messageId));
    } finally {
      if (entry === this.entryKey()) this.navigatingDown.set(false);
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
    this.atBottom.set(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40);
    if (!this.entered || this.document.hidden || this.conversation.loading() || this.position()) return;
    const rows = this.rows();
    const elements = this.messageElements().filter((_, index) => !!rows[index]?.confirmed);
    const viewport = scroll.getBoundingClientRect();
    const allElements = this.messageElements();
    let first = 0,
      last = allElements.length - 1;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (allElements[middle].nativeElement.getBoundingClientRect().bottom <= viewport.top) first = middle + 1;
      else last = middle;
    }
    this.visibleDate.set(rows[first]?.message.createdAt);
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
    const messageId = element?.getAttribute('data-message-id');
    const confirmedId = messageId ? encodeId(messageId) : undefined;
    if (element && confirmedId && element.getBoundingClientRect().bottom > viewport.top) {
      if (this.returnMessageIds().some((id) => id <= confirmedId))
        this.returnMessageIds.update((ids) => ids.filter((id) => id > confirmedId));
      const threadId = this.threadId();
      void (
        threadId
          ? this.chatInfo.markThreadRead(this.id(), threadId, confirmedId)
          : this.chatInfo.markRead(this.id(), confirmedId)
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
      const messageId = this.messages()[index]?.message().id;
      if (element && messageId)
        this.position.set({
          type: PositionKind.Anchor,
          messageId,
          // Prepending can remove this message's author header; preserve the content below it.
          offset: element.getBoundingClientRect().bottom - top,
        });
    });
  }

  protected updateDraft(text: string) {
    (this.editing() ? this.editText : this.draft).set(text);
  }

  protected saveDraft({ chatId, threadId } = { chatId: this.id(), threadId: this.threadId() }) {
    if (this.active() && this.session.user())
      this.drafts.save(chatId, threadId, this.draft(), this.replyTo()?.id ?? this.savedReplyId());
  }

  protected cancelReply() {
    this.replyTo.set(undefined);
    this.savedReplyId.set(undefined);
  }

  private async restoreReply(messageId: SnowflakeID) {
    const entry = this.entryKey();
    try {
      const message = await firstValueFrom(
        this.api.getMessage(entry.chatId, messageId).pipe(takeUntilDestroyed(this.destroyRef)),
      );
      if (this.isCurrent(entry) && this.savedReplyId() === messageId && !this.replyTo()) {
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

  protected async sendMessage(composition: Composition = { messageType: MessageType.text, attachmentIds: [] }) {
    const target = this.editTarget();
    const text = (target ? this.editText() : this.draft()).trim();
    if (!text && !composition.attachmentIds.length && !composition.uploads?.length && !composition.sticker) return;
    if (target) {
      const item =
        'delivery' in target
          ? this.outbox.edit(target, text, composition)
          : this.outbox.enqueueEdit(target, this.threadId(), text, composition);
      this.cancelEdit();
      return item.operation;
    }
    const item = this.outbox.enqueue(
      this.id(),
      this.threadId(),
      text,
      composition,
      this.replyTo(),
      this.replyTo()?.id ?? this.savedReplyId(),
    );
    if (composition.messageType === MessageType.text) {
      this.draft.set('');
      this.drafts.clear(this.id(), this.threadId());
    }
    this.cancelReply();
    this.position.set({ type: PositionKind.Bottom });
    if (!this.conversation.atLatest()) void this.goTo({ type: ConversationTargetKind.Latest });
    return item.operation;
  }

  private async refreshConversationMetadata() {
    await Promise.all([
      this.chatInfo.ensure(this.id()),
      this.loadThreadRoot(),
      this.threadId() ? this.loadSubscription() : this.chatInfo.getReadState(this.id()),
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
      await this.chatInfo.loadSubscription(this.id(), threadId);
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
      if (status.subscribed) await this.chatInfo.setThreadArchived(this.id(), threadId, !status.archived);
      else await this.chatInfo.subscribeThread(this.id(), threadId);
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
    this.replyTo.set(message);
    this.savedReplyId.set(undefined);
    if (this.atBottom()) this.position.set({ type: PositionKind.Bottom });
    void this.composer()?.setFocus();
  }
}
