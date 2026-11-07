import {
  afterRenderEffect,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  input,
  linkedSignal,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
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
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { chatbubbles } from 'ionicons/icons';
import { firstValueFrom, fromEvent, map } from 'rxjs';
import {
  GroupKind,
  GroupSearchMode,
  GroupSelectorScope,
  type MessagePreview as Preview,
  type MemberSummary,
  type SnowflakeID,
} from '../../../generated/models';
import { RpcApi } from '../../../generated/rpc-api';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { ChatAvatar, conversationAvatar, type ChatAvatarData } from '../chat-avatar/chat-avatar';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';
import { MessagePreview } from '../../messages/message-preview/message-preview';

export enum ChatPickerScope {
  ChatsAndThreads,
  Chats,
  JoinedGroups,
  Users,
}
export interface ChatPickerTarget {
  chatId: SnowflakeID;
  kind: GroupKind;
  threadId?: SnowflakeID;
  name?: string;
  avatar: ChatAvatarData;
  preview?: Preview;
  time: number;
}
interface UserPickerTarget {
  user: MemberSummary;
  name: string;
  avatar: ChatAvatarData;
  time: number;
  chatId?: never;
  threadId?: never;
  kind?: never;
  preview?: never;
}
type PickerTarget = ChatPickerTarget | UserPickerTarget;

type TargetQuery = ReturnType<ChatListStore['chats']> | ReturnType<ChatListStore['threads']>;
interface PickerSource {
  query: TargetQuery;
  errorKey: string;
  targets: () => PickerTarget[];
}
export type ChooseChat = (target: ChatPickerTarget, available: () => boolean) => boolean | Promise<boolean>;

@Component({
  selector: 'app-chat-picker',
  templateUrl: './chat-picker.html',
  styleUrl: './chat-picker.scss',
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
export class ChatPicker {
  readonly scope = input.required<ChatPickerScope>();
  readonly title = input.required<string>();
  readonly excludedId = input<SnowflakeID>();
  readonly choose = input<ChooseChat>();
  readonly userSelected = output<MemberSummary>();
  readonly submitted = input(false);
  readonly invalid = input(false);
  readonly failure = input<string>();
  readonly open = model(true);
  readonly closing = output<void>();
  readonly closed = output<void>();
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly Scope = ChatPickerScope;
  protected readonly query = signal('');
  protected readonly resolving = signal(false);
  protected readonly groupRows = signal<ChatPickerTarget[]>([]);
  private readonly groupCursor = signal<{ query: string; after: SnowflakeID } | undefined>(undefined);
  protected readonly groupsLoading = signal(false);
  protected readonly groupsError = signal(false);
  protected groupsFailedMore = false;
  private groupsVersion = 0;
  protected readonly users = signal<UserPickerTarget[]>([]);
  protected readonly usersLoading = signal(false);
  protected readonly usersError = signal(false);
  private usersVersion = 0;
  protected readonly sources = computed<PickerSource[]>(() => {
    if (this.scope() === ChatPickerScope.JoinedGroups) return [];
    const lists = untracked(() => this.injector.get(ChatListStore));
    if (this.scope() === ChatPickerScope.Users) {
      return [false, true].map((archived) => {
        const query = lists.chats(archived);
        return {
          query,
          errorKey: archived ? 'chats.picker.archivedFailed' : 'chats.picker.chatsFailed',
          targets: () =>
            query
              .items()
              .flatMap((chat) =>
                chat.kind === GroupKind.dm && chat.peer
                  ? [this.userTarget(chat.peer, Date.parse(chat.lastMessageAt ?? '') || -Infinity)]
                  : [],
              ),
        };
      });
    }
    const metadata = untracked(() => this.injector.get(ChatStore));
    const chatSource = (archived: boolean): PickerSource => {
      const query = lists.chats(archived);
      return {
        query,
        errorKey: archived ? 'chats.picker.archivedFailed' : 'chats.picker.chatsFailed',
        targets: () =>
          query.items().map((chat) => ({
            chatId: chat.id,
            kind: chat.kind,
            name: chat.peer?.username ?? chat.name,
            avatar: conversationAvatar(metadata.get(chat.id)),
            time: Date.parse(chat.lastMessageAt ?? '') || -Infinity,
          })),
      };
    };
    if (this.scope() === ChatPickerScope.Chats) return [chatSource(false), chatSource(true)];
    const threads = lists.threads(false);
    return [
      chatSource(false),
      {
        query: threads,
        errorKey: 'chats.picker.threadsFailed',
        targets: () =>
          threads.items().map((thread) => {
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
      },
    ];
  });
  protected readonly visibleSources = computed(() =>
    this.scope() === ChatPickerScope.Users && this.query().trim() ? [] : this.sources(),
  );
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
  protected readonly pressed = signal<SnowflakeID | string | undefined>(undefined);
  protected readonly scrolling = signal(false);
  protected readonly selected = signal<SnowflakeID | string | undefined>(undefined);
  protected readonly canDismiss = (_data?: unknown, role?: string) => !this.submitted() || role === 'navigate';
  protected readonly failed = computed(
    () => this.usersError() || this.groupsError() || this.visibleSources().some((source) => !!source.query.listError()),
  );
  private readonly retrying = signal(new Set<TargetQuery>());
  private readonly pageBusy = signal(false);
  private pageRequest?: Promise<void>;
  protected readonly manualPaging = signal(false);
  protected readonly paging = computed(
    () => this.pageBusy() || this.groupsLoading() || this.visibleSources().some((source) => source.query.loadingMore()),
  );
  protected readonly moreAvailable = computed(() =>
    this.scope() === ChatPickerScope.JoinedGroups
      ? this.groupCursor()?.query === this.query() && !this.groupsError()
      : this.visibleSources().some(({ query }) => !query.listError() && query.hasMore()),
  );
  protected readonly incomplete = computed(
    () =>
      this.moreAvailable() ||
      this.failed() ||
      this.visibleSources().some(({ query }) => query.loadedThrough() === Infinity),
  );
  protected readonly pending = computed(
    () =>
      this.usersLoading() ||
      (this.groupsLoading() && (!this.groupsFailedMore || !this.pageBusy())) ||
      this.visibleSources().some(({ query }) => this.retrying().has(query)) ||
      this.visibleSources().some(({ query }) => query.loading() && query.loadedThrough() === Infinity),
  );
  private readonly allTargets = computed<PickerTarget[]>(() => {
    if (this.scope() === ChatPickerScope.Users) {
      if (this.query().trim()) return this.users();
      const contacts = this.sources()
        .flatMap((source) => source.targets())
        .sort((a, b) => b.time - a.time);
      const unique = new Map<string | SnowflakeID, PickerTarget>();
      for (const contact of contacts) {
        const id = this.targetId(contact);
        if (!unique.has(id)) unique.set(id, contact);
      }
      return [...unique.values()];
    }
    const targets =
      this.scope() === ChatPickerScope.JoinedGroups
        ? this.groupRows()
        : this.sources()
            .flatMap((source) => source.targets())
            .sort((a, b) => b.time - a.time);
    return targets.filter((target) => target.chatId !== this.excludedId());
  });
  protected readonly initialLoading = computed(() => !this.allTargets().length && this.pending());
  /** During a press keep row positions, but accept current fields and removals immediately. */
  private readonly ordered = linkedSignal({
    source: () => ({ targets: this.allTargets(), interacting: this.pressed() != null || this.scrolling() }),
    computation: ({ targets, interacting }, previous): PickerTarget[] => {
      if (!interacting || !previous) return targets;
      const remaining = new Map(targets.map((target) => [this.targetId(target), target]));
      const kept = previous.value.flatMap((target) => {
        const id = this.targetId(target);
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
      (target) =>
        this.scope() === ChatPickerScope.JoinedGroups ||
        this.scope() === ChatPickerScope.Users ||
        !query ||
        `${target.name ?? ''} ${target.preview?.message ?? ''}`.toLocaleLowerCase().includes(query),
    );
  });
  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      clearTimeout(this.pointerRelease);
      this.listSize?.disconnect();
    });
    effect((onCleanup) => {
      const sources = this.sources();
      const releases = untracked(() => sources.map((source) => source.query.activate()));
      onCleanup(() => releases.forEach((release) => release()));
    });
    effect(() => {
      if (this.scope() !== ChatPickerScope.JoinedGroups) return;
      this.query();
      this.excludedId();
      untracked(() => void this.loadGroups());
    });
    effect(() => {
      if (this.scope() !== ChatPickerScope.Users) return;
      this.query();
      untracked(() => void this.loadUsers());
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
  protected press(target: PickerTarget) {
    clearTimeout(this.pointerRelease);
    this.pressed.set(this.targetId(target));
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
      this.closing.emit();
    }
  }
  protected dismissing() {
    this.open.set(false);
    this.closing.emit();
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
        const queries = this.visibleSources()
          .map((source) => source.query)
          .filter((query) => !query.listError() && query.hasMore());
        const boundary = Math.max(...queries.map((query) => query.loadedThrough()));
        const request = (
          this.scope() === ChatPickerScope.JoinedGroups
            ? this.loadGroups(true)
            : Promise.all(
                queries.filter((query) => query.loadedThrough() === boundary).map((query) => query.loadMore()),
              )
        )
          .then(() => {})
          .finally(() => {
            if (this.pageRequest !== request) return;
            this.pageRequest = undefined;
            this.pageBusy.set(false);
            this.manualPaging.set(false);
          });
        this.pageRequest = request;
      }
      await this.pageRequest;
    } finally {
      await event?.target.complete();
    }
  }
  protected async select(target: PickerTarget) {
    if (this.submitted() || this.invalid() || !this.open() || this.resolving()) return;
    const id = this.targetId(target);
    if (this.pressed() != null && this.pressed() !== id) return;
    const available = () =>
      !this.destroyRef.destroyed && this.open() && this.allTargets().some((current) => this.targetId(current) === id);
    if (!available()) return;
    this.selected.set(id);
    this.resolving.set(true);
    try {
      if ('user' in target) {
        this.userSelected.emit(target.user);
        this.open.set(false);
        return;
      }
      const accepted = await this.choose()?.(target, available);
      if (accepted && !this.destroyRef.destroyed) this.open.set(false);
    } finally {
      this.resolving.set(false);
      this.selected.set(undefined);
    }
  }
  protected targetId(target: PickerTarget): SnowflakeID | string {
    return 'user' in target ? `user:${target.user.uid}` : (target.threadId ?? target.chatId);
  }
  private userTarget(user: MemberSummary, time = 0): UserPickerTarget {
    const name = user.username || String(user.uid);
    return { user, name, avatar: { title: name, avatar: user.avatarUrl }, time };
  }
  protected async loadUsers() {
    const version = ++this.usersVersion;
    const q = this.query().trim();
    this.usersError.set(false);
    this.usersLoading.set(!!q);
    if (!q) {
      this.users.set([]);
      return;
    }
    try {
      const result = await firstValueFrom(this.injector.get(RpcApi).users.search({ q, limit: 40 }));
      if (version !== this.usersVersion || this.destroyRef.destroyed || !this.open()) return;
      this.users.set(result.members.map((user) => this.userTarget(user)));
    } catch {
      if (version === this.usersVersion && !this.destroyRef.destroyed && this.open()) this.usersError.set(true);
    } finally {
      if (version === this.usersVersion && !this.destroyRef.destroyed) this.usersLoading.set(false);
    }
  }
  protected async loadGroups(more = false) {
    const query = this.query();
    const cursor = this.groupCursor();
    if (more && (this.groupsLoading() || cursor?.query !== query)) return;
    if (!more) {
      this.groupCursor.set(undefined);
      this.pageRequest = undefined;
      this.pageBusy.set(false);
      this.manualPaging.set(false);
    }
    const version = ++this.groupsVersion;
    this.groupsFailedMore = more;
    this.groupsLoading.set(true);
    this.groupsError.set(false);
    try {
      const page = await firstValueFrom(
        this.injector.get(RpcApi).groups.list({
          q: query,
          mode: GroupSearchMode.submitted,
          scope: GroupSelectorScope.joined,
          limit: 50,
          after: more ? cursor?.after : undefined,
        }),
      );
      if (version !== this.groupsVersion || query !== this.query() || this.destroyRef.destroyed || !this.open()) return;
      const rows = page.groups.map((group) => ({
        chatId: group.id,
        kind: GroupKind.group,
        name: group.name,
        avatar: { title: group.name, avatar: group.avatar },
        time: 0,
      }));
      this.groupRows.update((previous) => (more ? [...previous, ...rows] : rows));
      this.groupCursor.set(page.nextCursor != null ? { query, after: page.nextCursor } : undefined);
    } catch {
      if (version === this.groupsVersion && !this.destroyRef.destroyed && this.open()) this.groupsError.set(true);
    } finally {
      if (version === this.groupsVersion && !this.destroyRef.destroyed) this.groupsLoading.set(false);
    }
  }
}
