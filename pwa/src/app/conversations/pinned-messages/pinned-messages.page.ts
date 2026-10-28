import {
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { IonButtons, IonContent, IonHeader, IonSpinner, IonTitle, IonToolbar } from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import type { MessageResponse } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { ChatStore } from '../../chats/chat-store';
import { MessageDatePipe } from '../../messages/message-date.pipe';
import { MessageMenu } from '../../messages/message-menu/message-menu';
import { isVisibleMessage } from '../../messages/message-visibility';
import { Message } from '../../messages/message/message';
import { PageBack } from '../../navigation/page-back';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { scrollActivity } from '../../scrolling/scroll-activity';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { LoadError } from '../../ui/load-error/load-error';
import { messageRows } from '../message-rows';

@Component({
  selector: 'app-pinned-messages',
  templateUrl: './pinned-messages.page.html',
  imports: [
    ContentScrollbars,
    MessageDatePipe,
    TranslocoPipe,
    LoadError,
    PageBack,
    IonButtons,
    IonContent,
    IonHeader,
    IonSpinner,
    IonTitle,
    IonToolbar,
    Message,
    MessageMenu,
  ],
})
export class PinnedMessagesPage {
  readonly id = input.required<SnowflakeID, string>({ transform: encodeId });
  readonly threadId = input<SnowflakeID | undefined, string | undefined>(undefined, {
    transform: (id) => (id ? encodeId(id) : undefined),
  });
  private readonly chatInfo = inject(ChatStore);
  protected readonly pins = computed(() => this.chatInfo.pins(this.id(), this.threadId()));
  protected readonly messages = computed(() =>
    this.pins()
      .items()
      .map((pin) => pin.message)
      .filter((message) => isVisibleMessage(message))
      .sort((a, b) => a.id - b.id),
  );
  protected readonly rows = computed(() => messageRows(this.messages()));
  protected readonly session = inject(SessionStore);
  protected readonly preferences = inject(Preferences);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly menu = viewChild(MessageMenu);
  private readonly content = viewChild.required(IonContent);
  private readonly floatingDate = viewChild.required<ElementRef<HTMLElement>>('floatingDate');
  private readonly dateSeparators = viewChildren<ElementRef<HTMLElement>>('dateSeparator');
  private readonly messageElements = viewChildren(Message, { read: ElementRef<HTMLElement> });
  protected readonly scrolling = scrollActivity();
  protected readonly dateColliding = signal(false);
  protected readonly hiddenDateKey = signal<number | undefined>(undefined);
  protected readonly visibleDate = signal<string | undefined>(undefined);
  private active = false;
  private version = 0;
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly backHref = computed(
    () => `/chats/chat/${decodeId(this.id())}${this.threadId() ? `/thread/${decodeId(this.threadId()!)}` : ''}`,
  );
  constructor() {
    effect(() => {
      this.id();
      this.threadId();
      untracked(() => this.activate());
    });
    inject(Connection)
      .resync$.pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.active) void this.load();
      });
    this.destroyRef.onDestroy(() => this.leave());
  }
  private activate() {
    this.active = true;
    this.version++;
    this.menu()?.reset();
    void this.load();
  }
  ionViewDidEnter() {
    if (!this.active) this.activate();
  }
  ionViewDidLeave() {
    this.leave();
    this.changeDetector.detectChanges();
  }
  private leave() {
    this.active = false;
    this.version++;
    this.loading.set(false);
    this.menu()?.reset();
    this.scrolling.reset();
  }
  protected async load() {
    const version = this.version;
    this.loading.set(true);
    this.failed.set(false);
    try {
      await Promise.all([this.pins().ensure(), this.chatInfo.ensureDetails(this.id())]);
    } catch {
      if (version === this.version) this.failed.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }
  protected async onScroll() {
    const rows = this.rows();
    const elements = this.messageElements();
    const scroll = await this.content().getScrollElement();
    if (!scroll || !rows.length || elements.length !== rows.length) return;
    const viewport = scroll.getBoundingClientRect();
    let first = 0;
    let last = elements.length - 1;
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
    let dateLow = 0;
    let dateHigh = dates.length;
    while (dateLow < dateHigh) {
      const mid = (dateLow + dateHigh) >>> 1;
      if (dates[mid].nativeElement.getBoundingClientRect().bottom < floatingTop - overlapMargin) dateLow = mid + 1;
      else dateHigh = mid;
    }
    const nextDate = dates[dateLow]?.nativeElement.getBoundingClientRect();
    this.dateColliding.set(!!nextDate && nextDate.top <= floatingBottom + overlapMargin);
    let dateRow = first;
    while (dateRow > 0 && !rows[dateRow]?.dateBreak) dateRow--;
    this.hiddenDateKey.set(dateRow);
  }
  protected locateMessage(message: MessageResponse, messageId: SnowflakeID) {
    void this.router.navigate(this.originalCommands(message), { fragment: `msg=${decodeId(messageId)}` });
  }
  protected replyTo(message: MessageResponse) {
    void this.router.navigate(this.originalCommands(message), { queryParams: { reply: decodeId(message.id) } });
  }
  protected openThread(chatId: SnowflakeID, rootId: SnowflakeID) {
    void this.router.navigate(['/chats/chat', decodeId(chatId), 'thread', decodeId(rootId)]);
  }
  private originalCommands(message: MessageResponse) {
    const threadId = this.pins().get(message.id)?.threadRootId ?? message.replyRootId;
    return ['/chats/chat', decodeId(message.chatId), ...(threadId ? ['thread', decodeId(threadId)] : [])];
  }
}
