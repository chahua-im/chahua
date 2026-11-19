import { Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonLabel,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import { MessageSearchSort, type MessageResponse, type SnowflakeID } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { messageChangePatch, recalledMessageIds } from '../../messages/message-change';
import { Message } from '../../messages/message/message';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { ModalButton } from '../../ui/modal-button';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { LoadError } from '../../ui/load-error/load-error';

const SEARCH_PAGE_SIZE = 40;

@Component({
  selector: 'app-chat-search',
  host: { class: 'ion-page' },
  templateUrl: './chat-search.html',
  imports: [
    ModalButton,
    ContentScrollbars,
    LoadError,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonSpinner,
    Message,
    TranslocoPipe,
  ],
})
export class ChatSearch {
  readonly chatId = input.required<SnowflakeID>();
  protected readonly panels = inject(PanelNavigation);
  protected readonly query = signal('');
  protected readonly queryLength = computed(() => Array.from(this.query().trim()).length);
  protected readonly sort = signal(MessageSearchSort.relevance);
  protected readonly Sort = MessageSearchSort;
  protected readonly messages = signal<MessageResponse[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly cursor = signal<number | undefined>(undefined);
  private readonly api = inject(RpcApi);
  private readonly realtime = inject(Connection);
  private readonly navigation = inject(ConversationNavigation);
  private readonly destroy = inject(DestroyRef);
  private readonly recalledHits = new Set<SnowflakeID>();
  private version = 0;
  constructor() {
    const resultCount = computed(() => this.messages().length);
    fillScrollViewport(this.loading, this.error, this.cursor, () => this.load(true), resultCount);
    this.realtime.changes$.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.payload.chatId !== this.chatId() || !recalledMessageIds(event)?.length) return;
      const patch = messageChangePatch(event);
      this.messages.update((messages) =>
        messages.map(patch).filter((message) => {
          if (!message.isDeleted) return true;
          this.recalledHits.add(message.id);
          return false;
        }),
      );
    });
    effect(() => {
      this.chatId();
      this.query();
      this.sort();
      untracked(() => void this.load());
    });
  }
  protected async more(event: InfiniteScrollCustomEvent) {
    try {
      await this.load(true);
    } finally {
      await event.target.complete();
    }
  }
  protected async load(more = false) {
    const cursor = more ? this.cursor() : undefined;
    if (more && (this.loading() || cursor == null)) return;
    const version = ++this.version;
    const chatId = this.chatId();
    const q = this.query().trim();
    const sort = this.sort();
    if (!more) {
      this.messages.set([]);
      this.cursor.set(undefined);
      this.recalledHits.clear();
    }
    this.error.set(false);
    const canSearch = this.queryLength() >= 2;
    this.loading.set(canSearch);
    if (!canSearch) return;
    // The index may remove the recalled hits before or after this read.
    const startOffset = () => (cursor == null ? undefined : Math.max(0, cursor - this.recalledHits.size));
    try {
      let offset = startOffset();
      for (;;) {
        const recalls = this.recalledHits.size;
        const page = await firstValueFrom(
          this.api.messages
            .search({ chatId, q, sort, limit: SEARCH_PAGE_SIZE, offset })
            .pipe(takeUntilDestroyed(this.destroy)),
        );
        if (version !== this.version || chatId !== this.chatId() || q !== this.query().trim() || sort !== this.sort())
          return;
        const rewind = startOffset();
        if (more && recalls !== this.recalledHits.size && offset !== rewind) {
          offset = rewind;
          continue;
        }
        const recallsBeforeMerge = this.recalledHits.size;
        this.appendResults(page.messages);
        const next = page.nextOffset;
        if (next == null || cursor == null || next > cursor) {
          this.cursor.set(next);
          return;
        }
        // A large recall can rewind by a whole page. Traverse the overlap before returning to scrolling.
        const updatedRewind = startOffset();
        offset = recallsBeforeMerge !== this.recalledHits.size && updatedRewind !== offset ? updatedRewind : next;
      }
    } catch {
      if (version === this.version) this.error.set(true);
    } finally {
      if (version === this.version) this.loading.set(false);
    }
  }

  private appendResults(messages: readonly MessageResponse[]) {
    const items = this.messages();
    const seen = new Set(items.map(({ id }) => id));
    const results: MessageResponse[] = [];
    for (const incoming of messages) {
      const message = this.realtime.redactKnownRecalls(incoming);
      if (message.isDeleted) this.recalledHits.add(message.id);
      else if (!seen.has(message.id)) {
        seen.add(message.id);
        results.push(message);
      }
    }
    if (results.length) this.messages.set([...items, ...results]);
  }

  protected async locate(message: MessageResponse) {
    await this.navigation.open(message.chatId, message.replyRootId, message.id);
  }
}
