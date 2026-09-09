import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  IonButton,
  IonContent,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
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
import { FriendRequestDirection, FriendRequestStatus, GroupKind, MessageType } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { ConversationNavigation, ConversationTargetKind } from '../../conversations/conversation-navigation';
import { DraftStore } from '../../conversations/draft-store';
import { MessagePreview } from '../../messages/message-preview/message-preview';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ChatListItem, type ChatListEntry } from '../chat-list-item/chat-list-item';
import { ChatListError, ChatListStore, FriendRequestAction } from '../chat-list-store';
import { ChatMute } from '../chat-mute/chat-mute';
import { ChatStore } from '../chat-store';
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
    IonButton,
    IonContent,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonRefresher,
    IonRefresherContent,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonSpinner,
    IonText,
    ChatListItem,
    MessagePreview,
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
  readonly selection = input.required<ListSelection>();
  readonly openList = output<ListSelection>();
  protected readonly list = this.selection;
  protected readonly chatQuery = computed(() => this.lists.chats(this.list().archived));
  protected readonly friendRequests = computed(() => this.lists.friendRequests(this.list().requestHistory));
  protected readonly threads = computed(() => this.lists.threads(this.list().archived));
  protected readonly showChats = computed(() => !this.list().requestHistory && this.list().tab !== ListTab.Threads);
  protected readonly showThreads = computed(
    () =>
      !this.list().requestHistory &&
      (this.list().tab === ListTab.Threads ||
        (this.list().tab === ListTab.Messages && this.preferences.showThreadsInMessages())),
  );
  private readonly visibleConversations = computed(() => {
    const chats = this.chatQuery().items();
    switch (this.list().tab) {
      case ListTab.Groups:
        return chats.filter((chat) => chat.kind === GroupKind.group);
      case ListTab.Friends:
        return chats.filter((chat) => chat.kind === GroupKind.dm);
      default:
        return chats;
    }
  });
  protected readonly session = inject(SessionStore);
  protected readonly conversationRows = computed(() =>
    this.visibleConversations().map((chat) => {
      const last = chat.lastMessage;
      const draft = this.drafts.get(chat.id);
      const muted = this.metadata.isMuted(chat.id);
      return {
        kind: ListRowKind.Chat as const,
        key: chat.id,
        chat,
        draft,
        sortTime: Math.max(Date.parse(chat.lastMessageAt ?? '') || -Infinity, draft?.savedAt ?? -Infinity),
        muted,
        isDm: chat.kind === GroupKind.dm,
        entry: {
          avatar: chat.kind === GroupKind.dm ? chat.peer?.avatarUrl : chat.avatar,
          sender:
            !draft && chat.kind === GroupKind.group && last && last.messageType !== MessageType.system
              ? (last.sender.name ?? String(last.sender.uid))
              : undefined,
          link: ['/chats/chat', decodeId(chat.id)],
          time:
            draft && draft.savedAt > (Date.parse(chat.lastMessageAt ?? '') || 0)
              ? new Date(draft.savedAt).toISOString()
              : chat.lastMessageAt,
          unreadCount: chat.unreadCount,
          muted,
        } satisfies ChatListEntry,
        toggleRead: last
          ? () => (chat.unreadCount > 0 ? this.metadata.markRead(chat.id, last.id) : this.metadata.markUnread(chat.id))
          : undefined,
        toggleMuted: () => this.muteMenu().toggle(chat.id),
        toggleArchived: () => this.metadata.setArchived(chat.id, !chat.archived),
      };
    }),
  );
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
        const last = thread.lastReply;
        const isDm = chat?.kind === GroupKind.dm;
        const peer = isDm ? thread.participants.find((user) => user.uid !== this.session.user()?.uid) : undefined;
        return {
          kind: ListRowKind.Thread as const,
          key: root.id,
          thread,
          draft,
          sortTime: Math.max(Date.parse(thread.lastReplyAt), draft?.savedAt ?? -Infinity),
          entry: {
            avatarName: isDm ? (chat.peer?.username ?? peer?.name ?? thread.chatName) : (chat?.name ?? thread.chatName),
            avatar: isDm ? (chat.peer?.avatarUrl ?? peer?.avatarUrl) : (chat?.avatar ?? thread.chatAvatar),
            badgeName: chat?.kind === GroupKind.group ? (root.sender.name ?? String(root.sender.uid)) : undefined,
            badgeAvatar: chat?.kind === GroupKind.group ? root.sender.avatarUrl : undefined,
            badgeIcon: isDm ? chatbubbles : undefined,
            sender:
              !draft && chat?.kind === GroupKind.group && last && last.messageType !== MessageType.system
                ? (last.sender.name ?? String(last.sender.uid))
                : undefined,
            time:
              draft && draft.savedAt > Date.parse(thread.lastReplyAt)
                ? new Date(draft.savedAt).toISOString()
                : thread.lastReplyAt,
            unreadCount: thread.unreadCount,
            muted: thread.archived,
            link: ['/chats/chat', decodeId(thread.chatId), 'thread', decodeId(root.id)],
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
    return visible.sort((a, b) => b.sortTime - a.sortTime);
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
  protected readonly countQueries = computed(
    () => {
      const { tab, archived, requestHistory } = this.list();
      if (archived || requestHistory) return [];
      return tab === ListTab.Messages
        ? [this.lists.archivedUnread.chats, ...(this.showThreads() ? [this.lists.archivedUnread.threads] : [])]
        : tab === ListTab.Threads
          ? [this.lists.archivedUnread.threads]
          : [this.lists.archivedUnread.chats];
    },
    { equal: (a, b) => a.length === b.length && a.every((query, index) => query === b[index]) },
  );
  protected readonly archivedUnreadCount = computed(() =>
    this.countQueries().reduce((total, query) => total + (query.value() ?? 0), 0),
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
