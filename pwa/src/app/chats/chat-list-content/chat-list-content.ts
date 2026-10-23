import {
  afterRenderEffect,
  afterNextRender,
  Component,
  DestroyRef,
  ElementRef,
  EnvironmentInjector,
  NgZone,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IonContent,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonRefresher,
  IonRefresherContent,
  IonText,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import {
  archiveOutline,
  chatbubbles,
  checkmarkDoneOutline,
  checkmarkOutline,
  closeOutline,
  mailUnreadOutline,
  notificationsOffOutline,
  notificationsOutline,
  personAddOutline,
} from 'ionicons/icons';
import {
  ConversationCategory,
  FriendRequestDirection,
  FriendRequestStatus,
  GroupKind,
  MessageType,
} from '../../../generated/models';
import { decodeId, type SnowflakeID } from '../../api/snowflake-id';
import { ConversationNavigation, ConversationTargetKind } from '../../conversations/conversation-navigation';
import { DraftStore } from '../../conversations/draft-store';
import type { MessageContent } from '../../messages/message/message';
import { MessageDelivery } from '../../messages/message-delivery';
import { MessageOutbox } from '../../messages/message-outbox';
import { MarkdownSummary } from '../../messages/message-preview/markdown-summary';
import { Presence } from '../../presence/presence';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ChatListItem, type ChatListEntry } from '../chat-list-item/chat-list-item';
import { ChatListError, ChatListStore, FriendRequestAction } from '../chat-list-store';
import { ChatMute } from '../chat-mute/chat-mute';
import { ChatStore } from '../chat-store';
import { chatListTraceEnabled, traceChatList } from '../chat-list-trace';
import { containsConversation, conversationView, mainCategories, threadCategories } from '../conversation-views';
import { ListTab, type ListSelection } from '../list-tabs';

enum ListRowKind {
  Chat,
  Thread,
}

@Component({
  selector: 'app-chat-list-content',
  templateUrl: './chat-list-content.html',
  styleUrl: './chat-list-content.scss',
  imports: [
    ChatMute,
    ContentScrollbars,
    LoadError,
    IonContent,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonRefresher,
    IonRefresherContent,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonText,
    ChatListItem,
    MessagePreview,
    MarkdownSummary,
    TranslocoPipe,
  ],
})
export class ChatListContent {
  readonly active = input(true);
  private readonly muteMenu = viewChild.required(ChatMute);
  private readonly drafts = inject(DraftStore);
  protected readonly lists = inject(ChatListStore);
  protected readonly navigation = inject(ConversationNavigation);
  private readonly preferences = inject(Preferences);
  private readonly metadata = inject(ChatStore);
  protected readonly presence = inject(Presence);
  private readonly presenceRows = viewChildren<ChatListItem, ElementRef<HTMLElement>>('presenceRow', {
    read: ElementRef,
  });
  private readonly outbox = inject(MessageOutbox);
  readonly selection = input.required<ListSelection>();
  readonly openList = output<ListSelection>();
  protected readonly list = this.selection;
  protected readonly chatQuery = computed(() => this.lists.chats(this.list().archived));
  protected readonly friendRequests = computed(() => this.lists.friendRequests(this.list().requestHistory));
  protected readonly threads = computed(() => this.lists.threads(this.list().archived));
  private readonly view = computed(() => conversationView(this.list(), this.preferences.showThreadsInMessages()));
  protected readonly showChats = computed(
    () =>
      !this.list().requestHistory &&
      mainCategories.some((category) => this.view().selector.categories?.includes(category)),
  );
  protected readonly showThreads = computed(
    () =>
      !this.list().requestHistory &&
      threadCategories.some((category) => this.view().selector.categories?.includes(category)),
  );
  private readonly visibleConversations = computed(() =>
    this.chatQuery()
      .items()
      .filter((chat) =>
        containsConversation(
          this.view().selector,
          { chatId: chat.id },
          chat.kind === GroupKind.dm ? ConversationCategory.dm : ConversationCategory.group,
          chat.archived,
        ),
      ),
  );
  protected readonly session = inject(SessionStore);
  /** Submitted messages keep their row current until the shared summary echoes them. */
  private readonly pendingPreviews = computed(() => {
    const previews = new Map<SnowflakeID, { message: MessageContent; delivery: MessageDelivery }>();
    for (const item of this.outbox.items()) {
      if (item.editId || item.cancelled()) continue;
      const message = item.message();
      const key = item.threadId ?? item.chatId;
      const current = previews.get(key);
      if (!current || current.message.createdAt < message.createdAt)
        previews.set(key, { message, delivery: item.delivery() });
    }
    return previews;
  });
  private previewDelivery(
    preview: Pick<MessageContent, 'sender' | 'id' | 'isDeleted' | 'messageType'> | undefined,
    pending: { delivery: MessageDelivery } | undefined,
    readThrough: SnowflakeID | undefined,
  ): Pick<ChatListEntry, 'delivery' | 'read'> | undefined {
    if (
      !preview ||
      preview.isDeleted ||
      preview.messageType === MessageType.system ||
      preview.sender.uid !== this.session.user()?.uid
    )
      return undefined;
    if (pending && pending.delivery !== MessageDelivery.Sent)
      return pending.delivery === MessageDelivery.Failed ? undefined : { delivery: MessageDelivery.Sending };
    return readThrough != null && preview.id != null && preview.id <= readThrough
      ? { delivery: MessageDelivery.Sent, read: true }
      : { delivery: MessageDelivery.Sent };
  }
  protected readonly conversationRows = computed(() => {
    const rows = this.visibleConversations().map((chat) => {
      const last = chat.lastMessage;
      const pending = this.pendingPreviews().get(chat.id);
      const pendingPreview =
        pending && (!chat.lastMessageAt || pending.message.createdAt > chat.lastMessageAt) ? pending : undefined;
      const preview = pendingPreview?.message ?? last;
      const draft = this.drafts.get(chat.id);
      const forward = this.drafts.forward(chat.id);
      const hasDraft = !!draft || !!forward?.length;
      const muted = this.metadata.isMuted(chat.id);
      return {
        kind: ListRowKind.Chat as const,
        key: chat.id,
        chat,
        draft,
        forward,
        preview,
        sortTime: Math.max(
          Date.parse(chat.lastMessageAt ?? '') || -Infinity,
          draft?.savedAt ?? -Infinity,
          Date.parse(pendingPreview?.message.createdAt ?? '') || -Infinity,
        ),
        muted,
        isDm: chat.kind === GroupKind.dm,
        entry: {
          avatar: chat.kind === GroupKind.dm ? chat.peer?.avatarUrl : chat.avatar,
          ...this.previewDelivery(
            hasDraft ? undefined : preview,
            pendingPreview,
            chat.kind === GroupKind.dm ? chat.peerLastReadMessageId : undefined,
          ),
          sender:
            !hasDraft && chat.kind === GroupKind.group && preview && preview.messageType !== MessageType.system
              ? (preview.sender.name ?? String(preview.sender.uid))
              : undefined,
          link: ['/chats/chat', decodeId(chat.id)],
          time:
            draft && draft.savedAt > (Date.parse(preview?.createdAt ?? '') || 0)
              ? new Date(draft.savedAt).toISOString()
              : (preview?.createdAt ?? chat.lastMessageAt),
          unreadCount: chat.unreadCount,
          unreadMentions: chat.kind === GroupKind.group ? chat.unreadMentions : 0,
          unreadReactions: chat.unreadReactions,
          muted,
        } satisfies ChatListEntry,
        toggleRead: last
          ? () => (chat.unreadCount > 0 ? this.metadata.markRead(chat.id, last.id) : this.metadata.markUnread(chat.id))
          : undefined,
        toggleMuted: () => this.muteMenu().toggle(chat.id),
        toggleArchived: () => this.metadata.setArchived(chat.id, !chat.archived),
      };
    });
    if (chatListTraceEnabled())
      traceChatList(
        'conversationRows',
        rows.map((row) => ({
          key: row.key,
          sortTime: row.sortTime,
          summaryAt: row.chat.lastMessageAt,
          pendingAt: this.pendingPreviews().get(row.chat.id)?.message.createdAt,
          draftAt: row.draft?.savedAt,
          previewAt: row.preview?.createdAt,
          preview: row.preview?.message,
        })),
      );
    return rows;
  });
  protected readonly showRequests = computed(
    () =>
      this.list().requestHistory ||
      (!this.list().archived && (this.list().tab === ListTab.Messages || this.list().tab === ListTab.Friends)),
  );
  protected readonly threadRows = computed(() =>
    this.threads()
      .items()
      .map((thread) => {
        const chat = this.metadata.get(thread.chatId);
        const root = thread.threadRootMessage;
        const draft = this.drafts.get(thread.chatId, root.id);
        const forward = this.drafts.forward(thread.chatId, root.id);
        const hasDraft = !!draft || !!forward?.length;
        const last = thread.lastReply;
        const pending = this.pendingPreviews().get(root.id);
        const pendingPreview = pending && pending.message.createdAt > thread.lastReplyAt ? pending : undefined;
        const preview = pendingPreview?.message ?? last;
        const latestAt = preview?.createdAt ?? thread.lastReplyAt;
        const isDm = thread.chatKind === GroupKind.dm;
        const peer = isDm ? thread.participants.find((user) => user.uid !== this.session.user()?.uid) : undefined;
        return {
          kind: ListRowKind.Thread as const,
          key: root.id,
          thread,
          draft,
          forward,
          preview,
          sortTime: Math.max(
            Date.parse(thread.lastReplyAt),
            Date.parse(pendingPreview?.message.createdAt ?? '') || -Infinity,
            draft?.savedAt ?? -Infinity,
          ),
          entry: {
            ...this.previewDelivery(
              hasDraft ? undefined : preview,
              pendingPreview,
              isDm ? thread.peerLastReadMessageId : undefined,
            ),
            avatarName: isDm
              ? (chat?.peer?.username ?? peer?.name ?? thread.chatName)
              : (chat?.name ?? thread.chatName),
            avatar: isDm ? (chat?.peer?.avatarUrl ?? peer?.avatarUrl) : (chat?.avatar ?? thread.chatAvatar),
            badgeName: !isDm ? (root.sender.name ?? String(root.sender.uid)) : undefined,
            badgeAvatar: !isDm ? root.sender.avatarUrl : undefined,
            badgeIcon: isDm ? chatbubbles : undefined,
            sender:
              !hasDraft && !isDm && preview && preview.messageType !== MessageType.system
                ? (preview.sender.name ?? String(preview.sender.uid))
                : undefined,
            time: draft && draft.savedAt > Date.parse(latestAt) ? new Date(draft.savedAt).toISOString() : latestAt,
            unreadCount: thread.unreadCount,
            unreadMentions: !isDm ? thread.unreadMentions : 0,
            unreadReactions: thread.unreadReactions,
            muted: thread.archived,
            link: ['/chats/chat', decodeId(thread.chatId), 'thread', decodeId(root.id)],
            state: { fromChatList: true },
          } satisfies ChatListEntry,
          markRead: () => this.metadata.markThreadRead(thread.chatId, root.id, last?.id ?? root.id),
          toggleArchived: () => this.metadata.setThreadArchived(thread.chatId, root.id, !thread.archived),
        };
      }),
  );
  private readonly mixed = computed(() => this.showChats() && this.showThreads());
  private readonly loadedThrough = computed(() =>
    Math.max(this.chatQuery().loadedThrough(), this.threads().loadedThrough()),
  );
  protected readonly rows = computed(() => {
    const rows = [
      ...(this.showChats() ? this.conversationRows() : []),
      ...(this.showThreads() ? this.threadRows() : []),
    ];
    const visible = this.mixed() ? rows.filter((row) => row.sortTime >= this.loadedThrough()) : rows;
    const sorted = visible.sort((a, b) => b.sortTime - a.sortTime);
    if (chatListTraceEnabled())
      traceChatList('rows', {
        tab: this.list().tab,
        rows: sorted.map(({ kind, key, sortTime }) => ({ kind: ListRowKind[kind], key, sortTime })),
      });
    return sorted;
  });
  protected readonly requestRows = computed(() => {
    const requests = this.friendRequests().items();
    return requests.map((request) => {
      const incoming = request.direction === FriendRequestDirection.incoming;
      return {
        request,
        incoming,
        peer: incoming ? request.from : request.to,
        canDecide:
          incoming &&
          (request.status === FriendRequestStatus.pending || request.status === FriendRequestStatus.archived),
        accept: () => this.lists.decideRequest(request.id, FriendRequestAction.Accept),
        reject: () => this.lists.decideRequest(request.id, FriendRequestAction.Reject),
        archive: () => this.lists.decideRequest(request.id, FriendRequestAction.Archive),
      };
    });
  });
  protected readonly showHistoryEntry = computed(
    () => this.list().tab === ListTab.Friends && !this.list().archived && !this.list().requestHistory,
  );
  protected readonly loading = computed(() => {
    return (
      (this.showChats() && this.chatQuery().loading()) ||
      (this.showThreads() && this.threads().loading()) ||
      (this.showRequests() && this.friendRequests().loading())
    );
  });
  protected readonly ready = linkedSignal({
    source: () => {
      const { tab, archived, requestHistory } = this.list();
      return `${tab}/${archived}/${requestHistory}/${this.showThreads()}`;
    },
    computation: () => false,
  });
  protected readonly hasMore = computed(
    () => (this.showChats() && this.chatQuery().hasMore()) || (this.showThreads() && !!this.threads().hasMore()),
  );
  protected readonly countQueries = computed(() => (this.list().requestHistory ? [] : [this.lists.viewUnread]), {
    equal: (a, b) => a.length === b.length && a[0] === b[0],
  });
  protected readonly archivedUnreadCount = computed(
    () =>
      this.lists.summary(conversationView({ ...this.list(), archived: true }, this.preferences.showThreadsInMessages()))
        ?.unreadMessageCount ?? 0,
  );
  protected readonly archiveIcon = archiveOutline;
  protected readonly requestsIcon = personAddOutline;
  protected readonly acceptIcon = checkmarkOutline;
  protected readonly rejectIcon = closeOutline;
  protected readonly readIcon = checkmarkDoneOutline;
  protected readonly unreadIcon = mailUnreadOutline;
  protected readonly mutedIcon = notificationsOffOutline;
  protected readonly unmutedIcon = notificationsOutline;
  protected readonly ListTab = ListTab;
  protected readonly ListRowKind = ListRowKind;
  protected readonly FriendRequestStatus = FriendRequestStatus;
  protected readonly latestTarget = ConversationTargetKind.Latest;
  protected readonly ChatListError = ChatListError;
  protected readonly refreshing = signal(false);
  private readonly refresher = viewChild(IonRefresher);

  constructor() {
    afterRenderEffect((onCleanup) => {
      if (
        !this.active() ||
        !this.rows().some((row) => row.kind === ListRowKind.Chat && row.isDm && row.chat.peer != null)
      )
        return;
      const targets = new Map<Element, number>();
      for (const { nativeElement } of this.presenceRows()) {
        const uid = nativeElement.getAttribute('data-presence-uid');
        if (uid != null) targets.set(nativeElement, Number(uid));
      }
      const visible = new Map<Element, number>();
      let watched = new Set<number>();
      let release: (() => void) | undefined;
      let observing = true;
      const observer = new IntersectionObserver((entries) => {
        if (!observing) return;
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target, targets.get(entry.target)!);
          else visible.delete(entry.target);
        }
        const users = new Set(visible.values());
        if (users.size === watched.size && [...users].every((uid) => watched.has(uid))) return;
        watched = users;
        release?.();
        release = users.size ? this.presence.watch({ userIds: [...users] }) : undefined;
      });
      for (const target of targets.keys()) observer.observe(target);
      onCleanup(() => {
        observing = false;
        observer.disconnect();
        release?.();
      });
    });
    if (chatListTraceEnabled()) {
      const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
      const destroy = inject(DestroyRef);
      // A root effect samples local data even while Ionic detaches the page.
      // It does not run change detection on the cached view.
      const probe = effect(
        () => {
          this.rows();
        },
        {
          injector: inject(EnvironmentInjector),
          manualCleanup: true,
        },
      );
      inject(NgZone).runOutsideAngular(() => {
        const snapshot = () => ({
          tab: this.list().tab,
          rows: Array.from(host.querySelectorAll<HTMLElement>('[data-row-key]')).map((row) => ({
            key: row.dataset['rowKey'],
            text: row.textContent?.trim(),
            top: row.getBoundingClientRect().top,
          })),
        });
        const observer = new MutationObserver(() => traceChatList('dom:mutation', snapshot()));
        observer.observe(host, { childList: true, subtree: true, characterData: true });
        destroy.onDestroy(() => {
          probe.destroy();
          observer.disconnect();
        });
        // Ionic may not have inserted this view into the page during construction.
        afterNextRender(() => {
          const page = host.closest('app-chats');
          traceChatList('probe:mounted', { tab: this.list().tab, connected: host.isConnected, page: !!page });
          const visibility = new MutationObserver(() => traceChatList('page:class', page?.className));
          if (page) visibility.observe(page, { attributes: true, attributeFilter: ['class'] });
          let frame = 0;
          const entering = () => {
            traceChatList('dom:willEnter', snapshot());
            frame = requestAnimationFrame(() => traceChatList('dom:first-raf', snapshot()));
          };
          page?.addEventListener('ionViewWillEnter', entering);
          destroy.onDestroy(() => {
            visibility.disconnect();
            page?.removeEventListener('ionViewWillEnter', entering);
            cancelAnimationFrame(frame);
          });
        });
      });
    }

    effect((onCleanup) => {
      if (!this.active()) return;
      const query = this.chatQuery();
      if (this.showChats()) onCleanup(untracked(() => query.activate()));
    });
    effect((onCleanup) => {
      if (!this.active()) return;
      const query = this.friendRequests();
      if (this.showRequests()) onCleanup(untracked(() => query.activate()));
    });
    effect((onCleanup) => {
      if (!this.active()) return;
      const query = this.threads();
      if (this.showThreads()) onCleanup(untracked(() => query.activate()));
    });
    effect((onCleanup) => {
      if (!this.active()) return;
      for (const query of this.countQueries()) onCleanup(untracked(() => query.activate()));
    });
    effect(() => {
      if (!this.active()) return;
      if (!this.showThreads()) return;
      const chatIds = new Set(
        this.threads()
          .items()
          .map((thread) => thread.chatId),
      );
      untracked(() => {
        for (const chatId of chatIds) void this.metadata.ensure(chatId).catch(() => {});
      });
    });
    effect(() => {
      // Reveal each list selection once all its sources have settled; later refreshes keep it mounted.
      if (this.active() && !this.ready() && !this.loading()) this.ready.set(true);
    });
    effect(() => {
      if (!this.loading()) {
        void this.refresher()?.complete();
        this.refreshing.set(false);
      }
    });
  }

  protected refresh() {
    for (const query of this.countQueries()) query.refresh();
    if (this.showThreads()) {
      this.metadata.invalidate();
      void this.threads().refresh();
    }
    if (this.showChats()) this.chatQuery().refresh();
    if (this.showRequests()) void this.friendRequests().refresh();
  }

  protected async loadMore(event: InfiniteScrollCustomEvent) {
    try {
      await Promise.all([
        ...(this.showChats() &&
        this.chatQuery().hasMore() &&
        (!this.mixed() || this.chatQuery().loadedThrough() >= this.loadedThrough())
          ? [this.chatQuery().loadMore()]
          : []),
        ...(this.showThreads() &&
        this.threads().hasMore() &&
        (!this.mixed() || this.threads().loadedThrough() >= this.loadedThrough())
          ? [this.threads().loadMore()]
          : []),
      ]);
    } finally {
      await event.target.complete();
    }
  }
}
