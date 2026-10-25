import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ToastController,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { chatbubbles } from 'ionicons/icons';
import { fromEvent, map } from 'rxjs';
import { GroupKind, ServerWsMessageType, type MessagePreview as Preview } from '../../../generated/models';
import { Connection } from '../../api/connection';
import type { SnowflakeID } from '../../api/snowflake-id';
import { ChatListStore } from '../../chats/chat-list-store';
import { ChatStore } from '../../chats/chat-store';
import { SpeakingAction } from '../../chats/speaking';
import { ChatAvatar, conversationAvatar, type ChatAvatarData } from '../../chats/chat-avatar/chat-avatar';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';
import { MessagePreview } from '../message-preview/message-preview';
import { ConversationNavigation, type ForwardDraftLocation } from '../../conversations/conversation-navigation';
import {
  canForward,
  forwardSourceMessage,
  ForwardSelectionError,
  MAX_FORWARD_MESSAGES,
  type ForwardSource,
  type ForwardSourcesLoader,
  type ForwardSourcesResult,
} from '../forwarding';

interface ForwardTarget {
  chatId: SnowflakeID;
  kind: GroupKind;
  threadId?: SnowflakeID;
  name?: string;
  avatar: ChatAvatarData;
  preview?: Preview;
  time: number;
}

type TargetQuery = ReturnType<ChatListStore['chats']> | ReturnType<ChatListStore['threads']>;

@Component({
  selector: 'app-forward-picker',
  templateUrl: './forward-picker.html',
  styleUrl: './forward-picker.scss',
  host: {
    '(document:pointerup)': 'releasePress()',
    '(document:pointercancel)': 'releasePress()',
    '(window:blur)': 'releasePress()',
  },
  imports: [
    TranslocoPipe,
    ContentScrollbars,
    LoadError,
    ChatAvatar,
    MessagePreview,
    IonModal,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonSearchbar,
    IonSpinner,
    IonList,
    IonItem,
    IonLabel,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
  ],
})
export class ForwardPicker {
  readonly messages = input<readonly ForwardSource[]>([]);
  /** Moves an existing forward draft only after the destination opens successfully. */
  readonly moveFrom = input<ForwardDraftLocation>();
  /** Replaces the fixed selection with the sources read when a target is chosen. */
  readonly load = input<ForwardSourcesLoader>();
  readonly closed = output<void>();
  private readonly lists = inject(ChatListStore);
  private readonly metadata = inject(ChatStore);
  private readonly navigation = inject(ConversationNavigation);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toasts = inject(ToastController);
  private readonly i18n = inject(TranslocoService);
  protected readonly chats = this.lists.chats(false);
  protected readonly threads = this.lists.threads(false);
  protected readonly query = signal('');
  protected readonly maxForwardMessages = MAX_FORWARD_MESSAGES;
  protected readonly failure = signal<ForwardSelectionError | undefined>(undefined);
  protected readonly resolving = signal(false);
  /** Only a fixed selection that became stale or unsupported blocks the target list. */
  protected readonly invalid = computed(
    () => this.failure() === ForwardSelectionError.Stale || this.failure() === ForwardSelectionError.Unavailable,
  );
  protected readonly submitted = signal(false);
  protected readonly open = signal(true);
  private readonly desktop = matchMedia('(min-width: 768px)');
  protected readonly mobile = toSignal(
    fromEvent<MediaQueryListEvent>(this.desktop, 'change').pipe(map((event) => !event.matches)),
    { initialValue: !this.desktop.matches },
  );
  private readonly modal = viewChild(IonModal);
  private readonly viewport = signal<HTMLElement | undefined>(undefined);
  private content?: HTMLIonContentElement;
  private listSize?: ResizeObserver;
  private observedList?: HTMLElement;
  private rows: HTMLElement[] = [];
  private anchors: { element: HTMLElement; offset: number }[] = [];
  private renderedQuery = '';
  private pointerRelease?: ReturnType<typeof setTimeout>;
  protected readonly pressed = signal<SnowflakeID | undefined>(undefined);
  protected readonly scrolling = signal(false);
  protected readonly selected = signal<SnowflakeID | undefined>(undefined);
  protected readonly canDismiss = (_data?: unknown, role?: string) => !this.submitted() || role === 'navigate';
  protected readonly chatsFailed = computed(() => !!this.chats.listError());
  protected readonly threadsFailed = computed(() => !!this.threads.listError());
  protected readonly failed = computed(() => this.chatsFailed() || this.threadsFailed());
  private readonly retrying = signal(new Set<TargetQuery>());
  private readonly pageBusy = signal(false);
  private pageRequest?: Promise<void>;
  private feedback?: HTMLIonToastElement;
  protected readonly manualPaging = signal(false);
  protected readonly paging = computed(() => this.pageBusy() || this.chats.loadingMore() || this.threads.loadingMore());
  protected readonly moreAvailable = computed(
    () => (!this.chatsFailed() && this.chats.hasMore()) || (!this.threadsFailed() && this.threads.hasMore()),
  );
  protected readonly incomplete = computed(
    () =>
      this.moreAvailable() ||
      this.failed() ||
      this.chats.loadedThrough() === Infinity ||
      this.threads.loadedThrough() === Infinity,
  );
  protected readonly pending = computed(
    () =>
      (this.chats.loading() && this.chats.loadedThrough() === Infinity) ||
      (this.threads.loading() && this.threads.loadedThrough() === Infinity) ||
      this.retrying().size > 0,
  );
  private readonly allTargets = computed(() => {
    const targets: ForwardTarget[] = [
      ...this.chats.items().map((chat) => ({
        chatId: chat.id,
        kind: chat.kind,
        name: chat.peer?.username ?? chat.name,
        avatar: conversationAvatar(this.metadata.get(chat.id)),
        time: Date.parse(chat.lastMessageAt ?? '') || -Infinity,
      })),
      ...this.threads.items().map((thread) => {
        const isDm = thread.chatKind === GroupKind.dm;
        const root = thread.threadRootMessage;
        return {
          chatId: thread.chatId,
          kind: thread.chatKind,
          threadId: root.id,
          name: thread.chatName,
          preview: root,
          avatar: {
            avatar: thread.chatAvatar,
            avatarName: thread.chatName,
            badgeName: !isDm ? (root.sender.name ?? String(root.sender.uid)) : undefined,
            badgeAvatar: !isDm ? root.sender.avatarUrl : undefined,
            badgeIcon: isDm ? chatbubbles : undefined,
          },
          time: Date.parse(thread.lastReplyAt),
        };
      }),
    ];
    return targets.sort((a, b) => b.time - a.time);
  });
  protected readonly initialLoading = computed(() => !this.allTargets().length && this.pending());
  /** During a press keep row positions, but accept current fields and removals immediately. */
  private readonly ordered = linkedSignal({
    source: () => ({ targets: this.allTargets(), interacting: this.pressed() != null || this.scrolling() }),
    computation: ({ targets, interacting }, previous): ForwardTarget[] => {
      if (!interacting || !previous) return targets;
      const remaining = new Map(targets.map((target) => [target.threadId ?? target.chatId, target]));
      const kept = previous.value.flatMap((target) => {
        const id = target.threadId ?? target.chatId;
        const current = remaining.get(id);
        remaining.delete(id);
        return current ? [current] : [];
      });
      return [...kept, ...remaining.values()];
    },
  });
  protected readonly targets = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.ordered().filter(
      (target) => !query || `${target.name ?? ''} ${target.preview?.message ?? ''}`.toLocaleLowerCase().includes(query),
    );
  });
  constructor() {
    const destroyRef = inject(DestroyRef);
    const releaseChats = this.chats.activate();
    const releaseThreads = this.threads.activate();
    destroyRef.onDestroy(() => {
      clearTimeout(this.pointerRelease);
      this.listSize?.disconnect();
      void this.feedback?.dismiss();
      releaseChats();
      releaseThreads();
    });
    effect(() => {
      // The same sheet instance survives width changes; desktop uses its fully open position.
      if (!this.mobile() && this.viewport()) void this.modal()?.setCurrentBreakpoint(1);
    });
    afterRenderEffect({
      earlyRead: () => {
        this.targets();
        this.failure();
        this.initialLoading();
        const viewport = this.viewport();
        const query = this.query().trim().toLocaleLowerCase();
        const reset = query !== this.renderedQuery;
        this.renderedQuery = query;
        if (!viewport) return undefined;
        if (reset) return { viewport, top: 0 };
        const anchor = this.anchors.find((anchor) => anchor.element.isConnected);
        if (!anchor || viewport.scrollTop === 0) return undefined;
        const offset =
          anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
        return { viewport, top: viewport.scrollTop + offset - anchor.offset };
      },
      write: (update) => {
        const change = update();
        if (change) change.viewport.scrollTop = change.top;
      },
      read: () => {
        this.targets();
        this.query();
        const list = this.content?.querySelector('ion-list');
        this.rows = Array.from(list?.querySelectorAll<HTMLElement>('ion-item') ?? []);
        if (list && list !== this.observedList) {
          this.listSize?.disconnect();
          this.observedList = list;
          this.listSize?.observe(list);
        }
        this.rememberPosition();
      },
    });
    inject(Connection)
      .changes$.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        const sources = this.messages();
        if (event.payload.chatId !== sources[0]?.chatId) return;
        const removed =
          event.type === ServerWsMessageType.messageDeleted
            ? [event.payload.id]
            : event.type === ServerWsMessageType.messagesBulkDeleted
              ? event.payload.messageIds
              : [];
        if (
          sources.some((source) => {
            const id = forwardSourceMessage(source)?.id;
            return id != null && removed.includes(id);
          })
        )
          this.failure.set(ForwardSelectionError.Stale);
      });
  }
  protected async presented(event: Event) {
    this.content = (event.target as HTMLIonModalElement).querySelector('ion-content')!;
    const viewport = await this.content.getScrollElement();
    if (this.destroyRef.destroyed || !this.open()) return;
    // Ionic hydrates inserted rows after Angular has rendered; preserve the anchor again
    // when their final height becomes available, without polling or interrupting scrolling.
    this.listSize = new ResizeObserver(() => {
      const anchor = this.anchors.find((anchor) => anchor.element.isConnected);
      if (anchor && viewport.scrollTop > 0) {
        const offset =
          anchor.element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
        viewport.scrollTop += offset - anchor.offset;
      }
      this.rememberPosition();
    });
    this.viewport.set(viewport);
    this.rememberPosition();
  }
  protected rememberPosition() {
    const viewport = this.viewport();
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    // Rows stay in DOM order. Find the visible window without measuring every loaded page,
    // including when the scrollbar jumps directly to a distant part of the list.
    let start = 0;
    let end = this.rows.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (this.rows[middle].getBoundingClientRect().bottom <= bounds.top) start = middle + 1;
      else end = middle;
    }
    const anchors: typeof this.anchors = [];
    const scrollTop = viewport.scrollTop;
    for (let index = start; index < this.rows.length; index++) {
      const element = this.rows[index];
      const row = element.getBoundingClientRect();
      if (row.top >= bounds.bottom) break;
      anchors.push({ element, offset: row.top - bounds.top + scrollTop });
    }
    this.anchors = anchors;
  }
  protected press(target: ForwardTarget) {
    clearTimeout(this.pointerRelease);
    this.pressed.set(target.threadId ?? target.chatId);
  }
  protected releasePress() {
    if (this.pressed() == null) return;
    // Keep the pressed identity through the click dispatched after pointerup.
    this.pointerRelease = setTimeout(() => this.pressed.set(undefined), 0);
  }
  protected expand() {
    if (this.mobile()) void this.modal()?.setCurrentBreakpoint(1);
  }
  protected close() {
    if (!this.submitted()) {
      this.open.set(false);
      void this.feedback?.dismiss();
    }
  }
  protected dismissing() {
    this.open.set(false);
    void this.feedback?.dismiss();
  }
  protected async retry(query: TargetQuery) {
    if (this.retrying().has(query)) return;
    this.retrying.update((queries) => new Set(queries).add(query));
    try {
      await query.retry();
    } finally {
      this.retrying.update((queries) => {
        const next = new Set(queries);
        next.delete(query);
        return next;
      });
    }
  }
  protected async more(event?: InfiniteScrollCustomEvent) {
    try {
      if (!this.pageRequest) {
        this.pageBusy.set(true);
        this.manualPaging.set(!event);
        const chatBoundary = this.chats.loadedThrough();
        const threadBoundary = this.threads.loadedThrough();
        const chats = !this.chatsFailed() && this.chats.hasMore();
        const threads = !this.threadsFailed() && this.threads.hasMore();
        this.pageRequest = Promise.all([
          ...(chats && (!threads || chatBoundary >= threadBoundary) ? [this.chats.loadMore()] : []),
          ...(threads && (!chats || threadBoundary >= chatBoundary) ? [this.threads.loadMore()] : []),
        ])
          .then(() => {})
          .finally(() => {
            this.pageRequest = undefined;
            this.pageBusy.set(false);
            this.manualPaging.set(false);
          });
      }
      await this.pageRequest;
    } finally {
      await event?.target.complete();
    }
  }
  protected async select(target: ForwardTarget) {
    if (this.submitted() || this.invalid() || !this.open() || this.resolving()) return;
    const id = target.threadId ?? target.chatId;
    if (this.pressed() != null && this.pressed() !== id) return;
    if (!this.allTargets().some((current) => (current.threadId ?? current.chatId) === id)) return;
    this.selected.set(id);
    void this.feedback?.dismiss();
    this.feedback = undefined;
    this.failure.set(undefined);
    this.resolving.set(true);
    try {
      try {
        if (target.kind !== GroupKind.dm) await this.metadata.ensureDetails(target.chatId);
      } catch {
        await this.report(ForwardSelectionError.NavigationFailed);
        return;
      }
      if (this.destroyRef.destroyed || !this.open()) return;
      if (
        !this.metadata.canSpeak(
          target.chatId,
          target.threadId ? SpeakingAction.ThreadReply : SpeakingAction.ChatMessage,
        )
      ) {
        await this.report(ForwardSelectionError.Restricted);
        return;
      }
      const result = await this.resolveSources();
      if (this.destroyRef.destroyed || !this.open() || this.submitted() || this.invalid()) return;
      if (!this.allTargets().some((current) => (current.threadId ?? current.chatId) === id)) {
        await this.report(ForwardSelectionError.NavigationFailed);
        return;
      }
      if ('error' in result) {
        await this.report(result.error);
        return;
      }
      const selection = result.sources;
      if (!this.forwardable(selection)) {
        if (this.load()) await this.report(ForwardSelectionError.TopicUnavailable);
        else this.failure.set(ForwardSelectionError.Unavailable);
        return;
      }
      this.failure.set(undefined);
      this.submitted.set(true);
      try {
        const opened = await this.navigation.prepareForward(target.chatId, target.threadId, selection, this.moveFrom());
        if (!opened) {
          this.submitted.set(false);
          await this.report(ForwardSelectionError.NavigationFailed);
        } else if (!this.destroyRef.destroyed) {
          this.open.set(false);
        }
      } catch {
        this.submitted.set(false);
        await this.report(ForwardSelectionError.NavigationFailed);
      }
    } finally {
      this.resolving.set(false);
      this.selected.set(undefined);
    }
  }
  private async resolveSources(): Promise<ForwardSourcesResult> {
    const load = this.load();
    if (!load) return { sources: this.messages() };
    try {
      return await load();
    } catch {
      return { error: ForwardSelectionError.LoadFailed };
    }
  }
  private async report(error: ForwardSelectionError) {
    if (this.destroyRef.destroyed || !this.open()) return;
    const toast = await this.toasts.create({
      message: this.i18n.translate(error, { max: MAX_FORWARD_MESSAGES }),
      duration: 3000,
    });
    if (!this.destroyRef.destroyed && this.open()) {
      this.feedback = toast;
      await toast.present();
    } else toast.remove();
  }
  /** Every source needs a server ID and must be allowed in a forward request. */
  private forwardable(selection: readonly ForwardSource[]): boolean {
    const messages = selection.map(forwardSourceMessage);
    return (
      !!messages.length &&
      messages.length <= MAX_FORWARD_MESSAGES &&
      messages.every((message) => !!message && canForward(message))
    );
  }
}
