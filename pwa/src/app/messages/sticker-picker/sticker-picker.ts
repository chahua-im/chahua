import { NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonCol,
  IonContent,
  IonFooter,
  IonGrid,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover,
  IonRow,
  IonTitle,
  IonToolbar,
  IonToast,
  ModalController,
} from '@ionic/angular';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { addOutline, chevronBackOutline, cubeOutline, heart, settingsOutline } from 'ionicons/icons';
import { filter, firstValueFrom, type Observable, takeUntil } from 'rxjs';
import { CHAHUA_BASE_URL } from '../../../generated/endpoints/chahua.base-url';
import { RpcApi } from '../../../generated/rpc-api';
import type {
  SnowflakeID,
  StickerPackDetailResponse,
  StickerPackSummary,
  StickerSummary,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import {
  AUTO_SORT_LIMIT,
  sortFavoriteStickersByPreference,
  sortStickerPacksByPreference,
  StickerPreferences,
} from '../../settings/sticker-preferences';
import { MediaLoaded } from '../media-loaded';
import { StickerEditor, type StickerEditorValue } from '../../settings/sticker-editor/sticker-editor';
import { StickerLibraryScroll } from './sticker-library-scroll';
import { appendSticker, removePackSticker, StickerUpdates } from '../sticker-updates';
import { detectFileMimeType, isHeicLikeMedia, withDetectedMimeType } from '../media-processing/file-type';

interface StickerGroup {
  id?: SnowflakeID;
  name?: string;
  ownerUid?: number;
  content?: StickerContent;
  placeholderRows?: number;
  fetching?: boolean;
  uploadError: boolean;
  loading: boolean;
  error: boolean;
}

type StickerContent = StickerPackDetailResponse | { stickers: StickerSummary[] };

@Component({
  selector: 'app-sticker-picker',
  templateUrl: './sticker-picker.html',
  styleUrl: './sticker-picker.scss',
  imports: [
    RouterLink,
    ContentScrollbars,
    MediaLoaded,
    StickerEditor,
    IonIcon,
    IonPopover,
    TranslocoPipe,
    NgTemplateOutlet,
    IonHeader,
    IonFooter,
    IonGrid,
    IonRow,
    IonCol,
    IonToolbar,
    IonToast,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
  ],
  host: { '[class.ion-page]': '!embedded()', '[class.embedded]': 'embedded()' },
})
export class StickerPicker {
  readonly selectable = input(true);
  readonly embedded = input(false);
  readonly grouped = input(false);
  readonly selected = output<StickerSummary>();
  protected readonly icons = { heart, cubeOutline, addOutline, settingsOutline, chevronBackOutline };
  protected readonly session = inject(SessionStore);
  private readonly preferences = inject(StickerPreferences);
  private readonly alerts = inject(AlertController);
  private readonly transloco = inject(TranslocoService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(CHAHUA_BASE_URL);
  protected readonly menu = signal<{ sticker: StickerSummary; event: Event } | undefined>(undefined);
  private hold?: { timer: ReturnType<typeof setTimeout>; x: number; y: number };
  private longPressed = false;
  readonly packId = input<SnowflakeID>();
  readonly stickerId = input<SnowflakeID>();
  protected readonly modals = inject(ModalController);
  protected readonly panels = inject(PanelNavigation);
  private readonly router = inject(Router);
  private readonly api = inject(RpcApi);
  private readonly updates = inject(StickerUpdates);
  private readonly libraryPacks = signal<StickerPackSummary[]>([]);
  protected readonly packs = computed(() =>
    this.selectable()
      ? sortStickerPacksByPreference(this.libraryPacks(), this.preferences.packOrder())
      : this.libraryPacks(),
  );
  private readonly destroyRef = inject(DestroyRef);
  private readonly contents = signal(new Map<SnowflakeID | undefined, StickerContent>());
  protected readonly activeId = signal<SnowflakeID | undefined>(undefined);
  private readonly content = computed<StickerContent>(() => this.contents().get(this.activeId()) ?? { stickers: [] });
  private readonly groupLoading = signal(new Set<SnowflakeID>());
  private readonly groupErrors = signal(new Set<SnowflakeID>());
  private readonly uploadErrors = signal(new Set<SnowflakeID>());
  private readonly packRequests = new Map<SnowflakeID, Promise<boolean>>();
  private readonly libraryReads = new Set<Map<SnowflakeID, StickerPackSummary>>();
  private selectionVersion = 0;
  private favoritesLoaded = false;
  private readonly selectingPack = signal(false);
  private readonly libraryScroll = viewChild<ElementRef<HTMLElement>>('libraryScroll');
  private readonly groupElements = viewChildren<ElementRef<HTMLElement>>('groupSection');
  private readonly packTabs = viewChildren<ElementRef<HTMLElement>>('packTab');
  protected readonly groups = computed<StickerGroup[]>(() => {
    if (!this.grouped())
      return [
        {
          id: this.activeId(),
          content: this.contents().get(this.activeId()),
          uploadError: this.activeId() != null && this.uploadErrors().has(this.activeId()!),
          loading: this.busy() || (this.activeId() != null && this.groupLoading().has(this.activeId()!)),
          error: this.error() || (this.activeId() != null && this.groupErrors().has(this.activeId()!)),
          ownerUid: this.pack()?.ownerUid,
        },
      ];
    return [
      {
        id: undefined,
        content: this.contents().get(undefined),
        placeholderRows: Math.ceil((this.contents().get(undefined)?.stickers.length ?? 0) / 4),
        uploadError: false,
        loading: this.busy(),
        error: this.error(),
      },
      ...this.packs().map((pack) => ({
        id: pack.id,
        name: pack.name,
        ownerUid: pack.ownerUid,
        content: this.contents().get(pack.id),
        placeholderRows: Math.ceil(
          ((this.contents().get(pack.id)?.stickers.length ?? pack.stickerCount) +
            (this.selectable() && pack.ownerUid === this.session.user()?.uid ? 1 : 0)) /
            4,
        ),
        fetching: this.groupLoading().has(pack.id),
        uploadError: this.uploadErrors().has(pack.id),
        loading: !this.contents().has(pack.id) && !this.groupErrors().has(pack.id),
        error: this.groupErrors().has(pack.id),
      })),
    ];
  });

  private setContent(content: StickerContent) {
    const id = 'id' in content ? content.id : undefined;
    this.contents.update((contents) => new Map(contents).set(id, content));
    this.activeId.set(id);
  }
  protected readonly pack = computed(() => {
    const content = this.content();
    return 'id' in content ? content : undefined;
  });
  protected readonly stickers = computed(() => this.content().stickers);
  private readonly chosenId = linkedSignal(() => this.stickerId());
  protected readonly chosen = computed(
    () => this.stickers().find((sticker) => sticker.id === this.chosenId()) ?? this.stickers().at(0),
  );
  private retryPackId?: SnowflakeID;
  private readonly operationBusy = signal(false);
  protected readonly pendingUpload = signal<{ file: File; packId: SnowflakeID } | undefined>(undefined);
  protected readonly uploadError = signal<string | undefined>(undefined);
  private readonly editor = viewChild(StickerEditor);
  protected readonly busy = computed(() => this.operationBusy() || this.selectingPack());
  protected readonly error = signal(false);
  protected readonly favoriteFailed = signal(false);
  protected readonly scroll = new StickerLibraryScroll({
    grouped: this.grouped,
    embedded: this.embedded,
    activeId: this.activeId,
    groups: this.groups,
    viewport: this.libraryScroll,
    sections: this.groupElements,
    tabs: this.packTabs,
    select: (id) => {
      if (id !== this.activeId()) this.beginSelection();
      this.activeId.set(id);
    },
    approach: (id) => void this.loadGroup(id),
  });
  constructor() {
    this.updates.favoriteChanged.pipe(takeUntilDestroyed()).subscribe((sticker) => {
      this.setFavorite(sticker, sticker.isFavorited);
      this.menu.update((menu) =>
        menu?.sticker.id === sticker.id
          ? { ...menu, sticker: { ...menu.sticker, isFavorited: sticker.isFavorited } }
          : menu,
      );
    });
    this.updates.subscribed.pipe(takeUntilDestroyed()).subscribe((pack) => {
      if (this.packId() || this.stickerId()) return;
      this.libraryPacks.update((packs) =>
        packs.some((item) => item.id === pack.id)
          ? packs.map((item) => (item.id === pack.id ? pack : item))
          : [...packs, pack],
      );
    });
    this.updates.removed.pipe(takeUntilDestroyed()).subscribe(({ id, deleted }) => {
      // Unsubscribing removes a library entry but keeps an explicitly opened detail available.
      if (!deleted && (this.packId() || this.stickerId())) return;
      const packs = this.packs();
      const index = packs.findIndex((pack) => pack.id === id);
      this.libraryPacks.set(packs.filter((pack) => pack.id !== id));
      this.contents.update((contents) => {
        const next = new Map(contents);
        next.delete(id);
        return next;
      });
      for (const errors of [this.groupErrors, this.uploadErrors])
        errors.update((ids) => new Set([...ids].filter((item) => item !== id)));
      this.menu.set(undefined);
      if (this.activeId() === id) {
        const next = packs[index + 1]?.id ?? packs[index - 1]?.id;
        if (this.grouped()) this.jumpToGroup(next);
        else {
          this.beginSelection();
          this.activeId.set(undefined);
          this.scroll.jump();
        }
      }
    });
    this.updates.added.pipe(takeUntilDestroyed()).subscribe(({ pack, sticker }) => {
      this.contents.update((contents) => {
        const current = contents.get(pack.id);
        return current && 'id' in current ? new Map(contents).set(pack.id, appendSticker(current, sticker)) : contents;
      });
      this.libraryPacks.update((packs) => {
        const existing = packs.find((item) => item.id === pack.id);
        if (!existing && (this.packId() || this.stickerId())) return packs;
        const current = existing ?? pack;
        const updated = {
          ...current,
          stickerCount: current.stickerCount + 1,
          previewSticker: current.previewSticker ?? sticker,
        };
        return existing ? packs.map((item) => (item.id === pack.id ? updated : item)) : [...packs, updated];
      });
    });
    this.updates.changed.pipe(takeUntilDestroyed()).subscribe((pack) => {
      const inLibrary = !this.packId() && !this.stickerId();
      if (inLibrary || this.contents().has(pack.id))
        this.contents.update((contents) => new Map(contents).set(pack.id, pack));
      this.libraryPacks.update((packs) =>
        packs.some((item) => item.id === pack.id)
          ? packs.map((item) => (item.id === pack.id ? pack : item))
          : inLibrary
            ? [...packs, pack]
            : packs,
      );
    });
    this.updates.stickerRemoved.pipe(takeUntilDestroyed()).subscribe(({ pack: source, stickerId }) => {
      const packId = source.id;
      const current = this.contents().get(packId);
      if (current && 'id' in current) {
        const updated = removePackSticker(current, stickerId);
        this.contents.update((contents) => new Map(contents).set(packId, updated));
        this.updatePackSummary(updated);
      } else {
        const summary = this.libraryPacks().find((pack) => pack.id === packId);
        if (summary?.previewSticker?.id === stickerId)
          this.updatePackSummary({ ...summary, previewSticker: undefined });
        // A summary may already include this deletion. Read membership instead of subtracting twice.
        if (summary || this.libraryReads.size || this.packRequests.has(packId)) void this.loadGroup(packId, true);
      }
    });
    inject(DestroyRef).onDestroy(() => this.cancelHold());
    effect(() => {
      const pack = this.packId();
      const sticker = this.stickerId();
      untracked(() => {
        if (pack) void this.openPack(pack);
        else if (sticker) void this.openSticker(sticker);
        else void this.load();
      });
    });
  }

  private beginSelection() {
    this.selectingPack.set(false);
    return ++this.selectionVersion;
  }

  private updatePackSummary(pack: StickerPackSummary) {
    for (const changes of this.libraryReads) changes.set(pack.id, pack);
    this.libraryPacks.update((packs) =>
      packs.map((current) =>
        current.id === pack.id
          ? { ...current, stickerCount: pack.stickerCount, previewSticker: pack.previewSticker }
          : current,
      ),
    );
  }

  private jumpToGroup(id?: SnowflakeID) {
    this.beginSelection();
    this.activeId.set(id);
    this.scroll.jump(id);
    if (id != null) void this.loadGroup(id);
  }

  protected selectFavorites() {
    if (this.grouped()) return this.jumpToGroup();
    else return this.load();
  }

  protected loadGroup(id: SnowflakeID, refresh = false): Promise<boolean> {
    const pending = this.packRequests.get(id);
    if (pending) return pending;
    if (!refresh && (this.contents().has(id) || this.groupErrors().has(id)))
      return Promise.resolve(this.contents().has(id));
    const request = this.readPack(id);
    this.packRequests.set(id, request);
    return request;
  }

  private async readPack(id: SnowflakeID) {
    const favorites = this.beginFavoriteRead();
    const removal = this.updates.removed.pipe(
      filter((event) => event.id === id && (event.deleted || (!this.packId() && !this.stickerId()))),
    );
    let removed = false;
    // Also cover a response already resolved but not yet committed by the await continuation.
    const subscription = removal.subscribe(() => (removed = true));
    this.groupLoading.update((ids) => new Set(ids).add(id));
    this.groupErrors.update((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    try {
      const pack = await firstValueFrom(
        this.updates.getPack(id).pipe(takeUntil(removal), takeUntilDestroyed(this.destroyRef)),
      );
      if (removed || this.destroyRef.destroyed) return false;
      this.contents.update((contents) => new Map(contents).set(id, this.applyFavoriteOverrides(pack, favorites)));
      this.updatePackSummary(pack);
      return true;
    } catch {
      if (!removed && !this.destroyRef.destroyed) this.groupErrors.update((ids) => new Set(ids).add(id));
      return false;
    } finally {
      subscription.unsubscribe();
      this.favoriteReads.delete(favorites);
      this.packRequests.delete(id);
      this.groupLoading.update((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  }

  protected retryGroup(group: StickerGroup) {
    if (!this.grouped()) return this.retry();
    return group.id != null ? this.loadGroup(group.id, true) : this.load();
  }
  protected async upload(event: Event, packId = this.pack()?.id) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || packId == null || this.busy()) return;
    const pack = this.contents().get(packId);
    if (!pack || !('id' in pack)) return;
    const mimeType = await detectFileMimeType(file);
    if (
      (!mimeType.startsWith('image/') && mimeType !== 'video/webm') ||
      isHeicLikeMedia({ mimeType, fileName: file.name }) ||
      file.size > 10 * 1024 * 1024
    ) {
      const alert = await this.alerts.create({
        header: this.transloco.translate('stickers.invalidUploadTitle'),
        message: this.transloco.translate('stickers.invalidUploadMessage'),
        buttons: [this.transloco.translate('common.ok')],
      });
      await alert.present();
      return;
    }
    this.uploadError.set(undefined);
    this.pendingUpload.set({ file: withDetectedMimeType(file, mimeType), packId });
  }

  protected async saveUpload(values: StickerEditorValue) {
    const pending = this.pendingUpload();
    if (!pending || this.busy() || !values.emoji.trim()) return;
    const pack = this.contents().get(pending.packId);
    if (!pack || !('id' in pack)) return;
    const uid = this.session.user()?.uid;
    this.operationBusy.set(true);
    this.uploadError.set(undefined);
    this.uploadErrors.update((ids) => {
      const next = new Set(ids);
      next.delete(pending.packId);
      return next;
    });
    try {
      const body = new FormData();
      body.append('file', pending.file, pending.file.name);
      body.append('emoji', values.emoji.trim());
      if (values.name.trim()) body.append('name', values.name.trim());
      const sticker = await firstValueFrom(
        this.http.post<StickerSummary>(`${this.baseUrl}/stickers/packs/${decodeId(pending.packId)}/stickers`, body),
      );
      if (this.session.user()?.uid !== uid) return;
      this.updates.added.next({ pack, sticker });
      await this.editor()?.dismiss();
    } catch {
      if (this.session.user()?.uid !== uid) return;
      this.uploadErrors.update((ids) => new Set(ids).add(pending.packId));
      this.uploadError.set(this.transloco.translate('stickers.addFailed'));
    } finally {
      if (this.session.user()?.uid === uid) this.operationBusy.set(false);
    }
  }
  protected async load() {
    const overrides = this.beginFavoriteRead();
    const selection = this.grouped() ? undefined : this.beginSelection();
    this.operationBusy.set(true);
    this.error.set(false);
    // A library response started before a creation must not remove the new pack or its count.
    const additions = new Map<SnowflakeID, StickerPackSummary>();
    const removals = new Set<SnowflakeID>();
    const changes = new Map<SnowflakeID, StickerPackSummary>();
    this.libraryReads.add(changes);
    const removedPreviews = new Map<SnowflakeID, Set<SnowflakeID>>();
    const subscription = this.updates.added.subscribe(({ pack, sticker }) => {
      const changed = changes.get(pack.id);
      if (changed)
        changes.set(pack.id, {
          ...changed,
          stickerCount: changed.stickerCount + 1,
          previewSticker: changed.previewSticker ?? sticker,
        });
      const current = additions.get(pack.id) ?? pack;
      additions.set(pack.id, {
        ...current,
        stickerCount: current.stickerCount + 1,
        previewSticker: current.previewSticker ?? sticker,
      });
    });
    subscription.add(this.updates.changed.subscribe((pack) => changes.set(pack.id, pack)));
    subscription.add(
      this.updates.subscribed.subscribe((pack) => {
        changes.set(pack.id, pack);
        removals.delete(pack.id);
      }),
    );
    subscription.add(
      this.updates.stickerRemoved.subscribe(({ pack, stickerId }) => {
        const ids = removedPreviews.get(pack.id) ?? new Set<SnowflakeID>();
        ids.add(stickerId);
        removedPreviews.set(pack.id, ids);
      }),
    );
    subscription.add(this.updates.removed.subscribe(({ id }) => removals.add(id)));
    try {
      const [favorites, subscribed, owned] = await Promise.all([
        firstValueFrom(this.api.stickers.listFavorites()),
        firstValueFrom(this.api.stickers.listSubscribedPacks()),
        firstValueFrom(this.api.stickers.listOwnedPacks()),
      ]);
      const merged = new Map([...subscribed.packs, ...owned.packs].map((pack) => [pack.id, pack]));
      for (const [id, added] of additions) {
        const current = merged.get(id);
        merged.set(
          id,
          current
            ? {
                ...current,
                stickerCount: Math.max(current.stickerCount, added.stickerCount),
                previewSticker: current.previewSticker ?? added.previewSticker,
              }
            : added,
        );
      }
      for (const [id, pack] of changes) merged.set(id, pack);
      for (const id of removals) merged.delete(id);
      for (const [id, pack] of merged)
        if (pack.previewSticker && removedPreviews.get(id)?.has(pack.previewSticker.id))
          merged.set(id, { ...pack, previewSticker: undefined });
      this.favoritesLoaded = true;
      const favoritesContent = this.applyFavoriteOverrides(
        {
          stickers: this.preferences.autoSortFavoritesEnabled()
            ? sortFavoriteStickersByPreference(favorites.stickers, this.preferences.favoriteStickerOrder())
            : favorites.stickers,
        },
        overrides,
        true,
      );
      if (this.grouped() || selection !== this.selectionVersion)
        this.contents.update((contents) => new Map(contents).set(undefined, favoritesContent));
      else this.setContent(favoritesContent);
      this.libraryPacks.set([...merged.values()]);
    } catch {
      this.error.set(true);
    } finally {
      this.favoriteReads.delete(overrides);
      this.libraryReads.delete(changes);
      subscription.unsubscribe();
      this.operationBusy.set(false);
    }
  }
  protected selectPack(id: SnowflakeID) {
    if (this.grouped()) return this.jumpToGroup(id);
    return this.embedded() || this.selectable() ? this.openPack(id) : this.router.navigate(['/stickers', decodeId(id)]);
  }

  private async openPack(id: SnowflakeID) {
    this.retryPackId = id;
    const selection = this.beginSelection();
    this.selectingPack.set(true);
    this.error.set(false);
    const loaded = await this.loadGroup(id, true);
    if (this.destroyRef.destroyed || selection !== this.selectionVersion) return;
    this.selectingPack.set(false);
    if (loaded) {
      if (!this.contents().has(id)) return;
      if (this.grouped()) this.jumpToGroup(id);
      else this.activeId.set(id);
    } else if (!this.grouped()) this.error.set(true);
  }
  private async openSticker(id: SnowflakeID) {
    this.retryPackId = undefined;
    this.operationBusy.set(true);
    this.error.set(false);
    try {
      const sticker = await firstValueFrom(this.api.stickers.get({ stickerId: id }));
      const pack = sticker.packs[0];
      this.retryPackId = pack?.id;
      if (pack) {
        if (await this.loadGroup(pack.id, true)) this.activeId.set(pack.id);
        else this.error.set(true);
      } else this.setContent({ stickers: [sticker] });
      this.libraryPacks.set(sticker.packs);
    } catch {
      this.error.set(true);
    } finally {
      this.operationBusy.set(false);
    }
  }
  protected retry() {
    const pack = this.activeId() ?? this.packId() ?? this.retryPackId;
    const sticker = this.stickerId();
    return pack ? this.openPack(pack) : sticker ? this.openSticker(sticker) : this.load();
  }
  private readonly favoriteReads = new Set<Map<SnowflakeID, StickerSummary>>();
  private pendingFavorite?: StickerSummary;
  private beginFavoriteRead() {
    const overrides = new Map<SnowflakeID, StickerSummary>();
    if (this.pendingFavorite) overrides.set(this.pendingFavorite.id, this.pendingFavorite);
    this.favoriteReads.add(overrides);
    return overrides;
  }
  private applyFavoriteOverrides(
    content: StickerContent,
    overrides: ReadonlyMap<SnowflakeID, StickerSummary>,
    favorites = false,
  ): StickerContent {
    let stickers = content.stickers.map((item) => {
      const override = overrides.get(item.id);
      return override ? { ...item, isFavorited: override.isFavorited } : item;
    });
    if (favorites) {
      stickers = stickers.filter((item) => overrides.get(item.id)?.isFavorited !== false);
      const ids = new Set(stickers.map((item) => item.id));
      for (const item of overrides.values()) if (item.isFavorited && !ids.has(item.id)) stickers.unshift(item);
      if (this.preferences.autoSortFavoritesEnabled())
        stickers = sortFavoriteStickersByPreference(stickers, this.preferences.favoriteStickerOrder());
    }
    return { ...content, stickers };
  }
  private setFavorite(sticker: StickerSummary, isFavorited: boolean) {
    const updated = { ...sticker, isFavorited };
    for (const overrides of this.favoriteReads) overrides.set(sticker.id, updated);
    const override = new Map([[sticker.id, updated]]);
    this.contents.update(
      (contents) =>
        new Map(
          [...contents].map(([id, content]) => [
            id,
            this.applyFavoriteOverrides(content, override, id == null && this.favoritesLoaded),
          ]),
        ),
    );
  }
  protected async favorite(sticker: StickerSummary) {
    if (this.busy()) return;
    const uid = this.session.user()?.uid;
    this.operationBusy.set(true);
    this.favoriteFailed.set(false);
    const previousFavorites = this.favoritesLoaded ? this.contents().get(undefined) : undefined;
    this.pendingFavorite = { ...sticker, isFavorited: !sticker.isFavorited };
    this.setFavorite(sticker, !sticker.isFavorited);
    try {
      await firstValueFrom(
        sticker.isFavorited
          ? this.api.stickers.unfavorite({ stickerId: sticker.id })
          : this.api.stickers.favorite({ stickerId: sticker.id }),
      );
      if (this.session.user()?.uid === uid)
        this.updates.favoriteChanged.next({ ...sticker, isFavorited: !sticker.isFavorited });
    } catch {
      this.setFavorite(sticker, sticker.isFavorited);
      if (previousFavorites) this.contents.update((contents) => new Map(contents).set(undefined, previousFavorites));
      this.favoriteFailed.set(true);
    } finally {
      this.pendingFavorite = undefined;
      this.operationBusy.set(false);
    }
  }
  protected async subscribe() {
    const pack = this.pack();
    if (!pack) return;
    const uid = this.session.user()?.uid;
    const saved = await this.updateContent(
      { ...pack, isSubscribed: !pack.isSubscribed },
      pack.isSubscribed
        ? this.api.stickers.unsubscribeFromPack({ packId: pack.id })
        : this.api.stickers.subscribeToPack({ packId: pack.id }),
    );
    if (!saved || this.session.user()?.uid !== uid) return;
    if (!pack.isSubscribed) {
      this.preferences.upsertPackOrderItem({ stickerPackId: pack.id, lastUsedOn: Date.now() });
      this.updates.subscribed.next({ ...pack, isSubscribed: true });
    } else if (pack.ownerUid !== uid) this.updates.removed.next({ id: pack.id, deleted: false });
  }
  private async updateContent(optimistic: StickerContent, request: Observable<unknown>) {
    if (this.busy()) return false;
    this.operationBusy.set(true);
    this.error.set(false);
    const previous = this.content();
    this.setContent(optimistic);
    try {
      await firstValueFrom(request);
      return true;
    } catch {
      if (this.content() === optimistic) {
        this.setContent(previous);
        this.error.set(true);
      }
      return false;
    } finally {
      this.operationBusy.set(false);
    }
  }
  protected send(sticker: StickerSummary, sourceId: SnowflakeID | null = this.pack()?.id ?? null) {
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    if (!this.selectable()) {
      this.chosenId.set(sticker.id);
      return;
    }
    this.recordUsage(sticker, sourceId);
    if (this.embedded()) this.selected.emit(sticker);
    else void this.modals.dismiss(sticker, 'send');
  }
  private recordUsage(sticker: StickerSummary, sourceId: SnowflakeID | null) {
    if (sourceId != null) {
      if (!this.preferences.autoSortPacksEnabled()) return;
      const index = this.packs().findIndex((item) => item.id === sourceId);
      if (index < 0 || index >= AUTO_SORT_LIMIT) return;
      const item = { stickerPackId: sourceId, lastUsedOn: Date.now() };
      this.preferences.upsertPackOrderItem(item);
      void this.preferences.syncPackOrder([{ ...item, isAutoSort: true }]);
    } else if (this.preferences.autoSortFavoritesEnabled()) {
      this.preferences.upsertFavoriteStickerOrderItem({ stickerId: sticker.id, lastUsedOn: Date.now() });
      const favorites = this.contents().get(undefined);
      if (favorites)
        this.contents.update((contents) =>
          new Map(contents).set(undefined, {
            stickers: sortFavoriteStickersByPreference(favorites.stickers, this.preferences.favoriteStickerOrder()),
          }),
        );
    }
  }
  protected press(sticker: StickerSummary, event: PointerEvent) {
    if (!this.selectable()) return;
    this.cancelHold();
    this.longPressed = false;
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    this.hold = { x: event.clientX, y: event.clientY, timer: setTimeout(() => this.showMenu(sticker, event), 400) };
  }
  protected move(event: PointerEvent) {
    if (this.hold && (Math.abs(event.clientX - this.hold.x) > 10 || Math.abs(event.clientY - this.hold.y) > 10))
      this.cancelHold();
  }
  protected cancelHold() {
    clearTimeout(this.hold?.timer);
    this.hold = undefined;
  }
  protected showMenu(sticker: StickerSummary, event: Event) {
    event.preventDefault();
    if (!this.selectable()) return;
    this.cancelHold();
    this.longPressed = true;
    this.menu.set({ sticker, event });
  }
  protected async toggleFavorite() {
    const sticker = this.menu()?.sticker;
    if (!sticker) return;
    this.menu.set(undefined);
    await this.favorite(sticker);
  }
}
