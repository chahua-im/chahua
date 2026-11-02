import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonLabel,
  IonProgressBar,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToolbar,
  type InfiniteScrollCustomEvent,
} from '@ionic/angular';
import { TranslocoPipe } from '@jsverse/transloco';
import { chevronBackOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import { StickerPackSort, type SnowflakeID, type StickerPackDiscoveryItem } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { fillScrollViewport } from '../../scrolling/fill-scroll-viewport';
import { SessionStore } from '../../session/session-store';
import { StickerPreferences } from '../../settings/sticker-preferences';
import { StickerEditor, type StickerEditorValue } from '../../settings/sticker-editor/sticker-editor';
import { LoadError } from '../../ui/load-error/load-error';
import { MediaLoaded } from '../media-loaded';
import { StickerUpdates } from '../sticker-updates';

@Component({
  selector: 'app-sticker-discovery',
  host: { class: 'ion-page' },
  templateUrl: './sticker-discovery.html',
  styleUrl: './sticker-discovery.scss',
  imports: [
    StickerEditor,
    RouterLink,
    ContentScrollbars,
    LoadError,
    MediaLoaded,
    TranslocoPipe,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
    IonLabel,
    IonProgressBar,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToolbar,
  ],
})
export class StickerDiscovery {
  protected readonly panels = inject(PanelNavigation);
  protected readonly backIcon = chevronBackOutline;
  protected readonly query = signal('');
  protected readonly sort = signal(StickerPackSort.trending);
  protected readonly Sort = StickerPackSort;
  protected readonly decodeId = decodeId;
  protected readonly packs = signal<StickerPackDiscoveryItem[]>([]);
  protected readonly loading = signal(false);
  protected readonly pageRequest = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal(false);
  protected readonly cursor = signal<number | undefined>(undefined);
  protected readonly recentWindowDays = signal(30);
  protected readonly adding = signal(new Set<SnowflakeID>());
  protected readonly addFailed = signal(false);
  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly createFailed = signal(false);
  private readonly editor = viewChild(StickerEditor);
  private readonly router = inject(Router);
  private readonly api = inject(RpcApi);
  private readonly session = inject(SessionStore);
  private readonly uid = computed(() => this.session.user()?.uid);
  private readonly updates = inject(StickerUpdates);
  private readonly preferences = inject(StickerPreferences);
  private readonly destroy = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly content = viewChild(IonContent);
  private readonly subscriptionOverrides = new Map<SnowflakeID, boolean>();
  private readonly deleted = new Set<SnowflakeID>();
  private version = 0;
  private displayedQuery = '';
  private displayedSort = StickerPackSort.trending;

  constructor() {
    fillScrollViewport(this.loading, this.error, this.cursor, () => this.load(true));
    this.updates.subscribed.pipe(takeUntilDestroyed()).subscribe((pack) => this.setSubscribed(pack.id, true));
    this.updates.removed.pipe(takeUntilDestroyed()).subscribe(({ id, deleted }) => {
      if (deleted) {
        this.deleted.add(id);
        this.packs.update((packs) => packs.filter((pack) => pack.id !== id));
      } else this.setSubscribed(id, false);
    });
    effect(() => {
      this.uid();
      untracked(() => {
        ++this.version;
        this.packs.set([]);
        this.loaded.set(false);
        this.error.set(false);
        this.cursor.set(undefined);
        this.adding.set(new Set());
        this.addFailed.set(false);
        this.createOpen.set(false);
        this.creating.set(false);
        this.createFailed.set(false);
        this.subscriptionOverrides.clear();
        this.deleted.clear();
      });
    });
    effect(() => {
      const uid = this.uid();
      this.query();
      this.sort();
      untracked(() => {
        if (uid != null) void this.load();
        else this.loading.set(false);
      });
    });
  }

  protected retry() {
    return this.load(this.pageRequest());
  }

  protected createPack() {
    this.createFailed.set(false);
    this.createOpen.set(true);
  }

  protected async savePack({ name }: StickerEditorValue) {
    if (this.creating() || !name.trim()) return;
    const uid = this.uid();
    this.creating.set(true);
    this.createFailed.set(false);
    try {
      const pack = await firstValueFrom(this.api.stickers.createPack({ name: name.trim() }));
      if (this.uid() !== uid) return;
      this.updates.changed.next({ ...pack, stickers: [] });
      this.preferences.upsertPackOrderItem({ stickerPackId: pack.id, lastUsedOn: Date.now() });
      if (this.destroy.destroyed) return;
      await this.editor()?.dismiss();
      if (this.destroy.destroyed || this.uid() !== uid) return;
      this.createOpen.set(false);
      await this.router.navigate(['/settings/stickers', decodeId(pack.id)]);
    } catch {
      if (!this.destroy.destroyed && this.uid() === uid) this.createFailed.set(true);
    } finally {
      if (!this.destroy.destroyed && this.uid() === uid) this.creating.set(false);
    }
  }

  protected async more(event: InfiniteScrollCustomEvent) {
    try {
      await this.load(true);
    } finally {
      await event.target.complete();
    }
  }

  protected async load(more = false) {
    if (more && (this.loading() || this.cursor() == null)) return;
    const version = ++this.version;
    const uid = this.uid();
    const q = this.query().trim();
    const sort = this.sort();
    const changedQuery = q !== this.displayedQuery || sort !== this.displayedSort;
    const offset = more ? this.cursor()! : 0;
    // Only changes overlapping this read override the server's subscription snapshot.
    this.subscriptionOverrides.clear();
    for (const id of this.adding()) this.subscriptionOverrides.set(id, true);
    this.deleted.clear();
    // Retain known rows while replacing a search or ranking, but disable old pagination.
    if (!more) this.cursor.set(undefined);
    this.loading.set(true);
    this.error.set(false);
    this.pageRequest.set(more);
    try {
      const page = await firstValueFrom(
        this.api.stickers
          .listPacks({
            q: q || undefined,
            sort,
            limit: 20,
            offset,
          })
          .pipe(takeUntilDestroyed(this.destroy)),
      );
      if (version !== this.version || this.uid() !== uid || this.destroy.destroyed) return;
      const packs = page.packs
        .filter((pack) => !this.deleted.has(pack.id))
        .map((pack) => ({
          ...pack,
          isSubscribed: this.subscriptionOverrides.get(pack.id) ?? pack.isSubscribed,
        }));
      this.packs.update((current) =>
        more ? [...new Map([...current, ...packs].map((pack) => [pack.id, pack])).values()] : packs,
      );
      this.cursor.set(page.hasMore ? offset + page.packs.length : undefined);
      this.recentWindowDays.set(page.recentWindowDays);
      this.loaded.set(true);
      this.displayedQuery = q;
      this.displayedSort = sort;
    } catch {
      if (version === this.version && this.uid() === uid && !this.destroy.destroyed) this.error.set(true);
    } finally {
      if (version === this.version && this.uid() === uid && !this.destroy.destroyed) {
        this.loading.set(false);
        if (!more && changedQuery)
          afterNextRender(
            () => {
              if (version === this.version) void this.content()?.scrollToTop(0);
            },
            { injector: this.injector },
          );
      }
    }
  }

  private setSubscribed(id: SnowflakeID, isSubscribed: boolean) {
    this.subscriptionOverrides.set(id, isSubscribed);
    this.packs.update((packs) => packs.map((pack) => (pack.id === id ? { ...pack, isSubscribed } : pack)));
  }

  protected async add(pack: StickerPackDiscoveryItem) {
    if (pack.isSubscribed || this.adding().has(pack.id)) return;
    const uid = this.uid();
    this.adding.update((ids) => new Set(ids).add(pack.id));
    this.setSubscribed(pack.id, true);
    this.addFailed.set(false);
    try {
      await firstValueFrom(this.api.stickers.subscribeToPack({ packId: pack.id }));
      if (this.uid() !== uid) return;
      this.preferences.upsertPackOrderItem({ stickerPackId: pack.id, lastUsedOn: Date.now() });
      this.updates.subscribed.next({ ...pack, isSubscribed: true });
    } catch {
      if (this.uid() !== uid || this.destroy.destroyed) return;
      this.setSubscribed(pack.id, false);
      this.addFailed.set(true);
    } finally {
      if (this.uid() === uid && !this.destroy.destroyed)
        this.adding.update((ids) => new Set([...ids].filter((id) => id !== pack.id)));
    }
  }
}
