import { Component, computed, DestroyRef, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import type { ItemReorderEventDetail } from '@ionic/angular';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonChip,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPopover,
  IonReorder,
  IonReorderGroup,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { addOutline, chevronBackOutline, closeCircleOutline, cubeOutline, happyOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { StickersService } from '../../../generated/endpoints/stickers/stickers.service';
import type { StickerPackSummary, UpdateStickerPackOrderItem } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { EmojiPicker } from '../../messages/emoji-picker/emoji-picker';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';
import { Preferences } from '../preferences';
import { StickerEditor, type StickerEditorValue } from '../sticker-editor/sticker-editor';
import { AUTO_SORT_LIMIT, sortStickerPacksByPreference, StickerPreferences } from '../sticker-preferences';

@Component({
  selector: 'app-sticker-settings',
  templateUrl: './sticker-settings.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    StickerEditor,
    ContentScrollbars,
    EmojiPicker,
    LoadError,
    IonChip,
    IonBadge,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonPopover,
    IonReorder,
    IonReorderGroup,
    IonSpinner,
    IonTitle,
    IonToggle,
    IonToolbar,
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
  styles: `
    .pack-preview {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pack-preview img,
    .pack-preview video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      border-radius: 4px;
    }
    h2 {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h2 .pack-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    h2 ion-badge {
      flex-shrink: 0;
      font-size: var(--app-font-caption);
      font-weight: normal;
    }
    .sort-divider {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 4px 16px;
      pointer-events: none;
    }
    .sort-divider::before,
    .sort-divider::after {
      content: '';
      width: 100%;
      height: 1px;
      background: var(--ion-color-step-300);
    }
    .sort-divider span {
      font-size: var(--app-font-caption);
      padding: 2px 8px;
      margin: 4px 0;
      color: var(--ion-color-medium);
      background: var(--ion-item-background, var(--ion-background-color, #fff));
      border-radius: 12px;
    }
  `,
})
export class StickerSettings {
  private readonly destroy = inject(DestroyRef);
  private readonly editor = viewChild(StickerEditor);
  private readonly api = inject(StickersService);
  private readonly transloco = inject(TranslocoService);
  private readonly router = inject(Router);
  protected readonly panels = inject(PanelNavigation);
  protected readonly preferences = inject(StickerPreferences);
  protected readonly reactions = inject(Preferences);
  protected readonly icons = { happyOutline, addOutline, cubeOutline, closeCircleOutline };
  protected readonly backIcon = chevronBackOutline;
  protected readonly autoSortLimit = AUTO_SORT_LIMIT;
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal(false);
  protected readonly choosingPinned = signal(false);
  private readonly owned = signal<StickerPackSummary[]>([]);
  private readonly packs = signal<StickerPackSummary[]>([]);
  protected readonly ownedIds = computed(() => new Set(this.owned().map((pack) => pack.id)));
  protected readonly orderedPacks = computed(() =>
    sortStickerPacksByPreference(this.packs(), this.preferences.packOrder()),
  );
  protected readonly creating = signal(false);
  protected readonly createOpen = signal(false);
  protected readonly createError = signal<string | undefined>(undefined);
  protected readonly savingOrder = signal(false);
  protected readonly orderFailed = signal(false);
  private pendingOrder?: UpdateStickerPackOrderItem;
  private lastReorder = 0;

  constructor() {
    void this.load();
  }

  protected async load() {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const [ownedPacks, subscribed] = await Promise.all([
        firstValueFrom(this.api.getMyOwnedPacks()),
        firstValueFrom(this.api.getMySubscribedPacks()),
      ]);
      this.loaded.set(true);
      this.owned.set(ownedPacks.packs);
      this.packs.set([
        ...ownedPacks.packs,
        ...subscribed.packs.filter((pack) => !ownedPacks.packs.some((item) => item.id === pack.id)),
      ]);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected removePinned(emoji: string) {
    this.reactions.setPinnedReactions(this.reactions.pinnedReactions().filter((item) => item !== emoji));
  }

  protected addPinned(emoji: string) {
    const pinned = this.reactions.pinnedReactions();
    if (pinned.includes(emoji) || pinned.length >= 5) return;
    this.reactions.setPinnedReactions([...pinned, emoji]);
    if (this.reactions.pinnedReactions().length === 5) this.choosingPinned.set(false);
  }

  protected createPack() {
    this.createError.set(undefined);
    this.createOpen.set(true);
  }

  protected async savePack({ name }: StickerEditorValue) {
    if (this.creating() || !name.trim()) return;
    this.creating.set(true);
    this.createError.set(undefined);
    try {
      const pack = await firstValueFrom(this.api.postPack({ name: name.trim() }));
      if (this.destroy.destroyed) return;
      this.owned.update((owned) => [...owned, pack]);
      this.packs.update((packs) => [pack, ...packs]);
      this.preferences.upsertPackOrderItem({ stickerPackId: pack.id, lastUsedOn: Date.now() });
      await this.editor()?.dismiss();
      if (this.destroy.destroyed) return;
      this.createOpen.set(false);
      await this.router.navigate(['/settings/stickers', decodeId(pack.id)]);
    } catch {
      this.createError.set(this.transloco.translate('stickers.createFailed'));
    } finally {
      this.creating.set(false);
    }
  }

  protected openPack(pack: StickerPackSummary) {
    if (Date.now() - this.lastReorder < 300) return;
    return this.router.navigate(['/settings/stickers', decodeId(pack.id)]);
  }

  protected async reorder(event: CustomEvent<ItemReorderEventDetail>) {
    if (this.savingOrder()) {
      event.detail.complete(false);
      return;
    }
    this.lastReorder = Date.now();
    const items = event.detail.complete(this.orderedPacks());
    this.packs.set(items);
    const to = event.detail.to;
    const prev = to > 0 ? items[to - 1] : undefined;
    const next = to < items.length - 1 ? items[to + 1] : undefined;
    const order = this.preferences.packOrder();
    const lastUsed = (pack?: StickerPackSummary) =>
      pack && order.find((item) => item.stickerPackId === pack.id)?.lastUsedOn;
    const pLast = lastUsed(prev);
    const nLast = lastUsed(next);
    let lastUsedOn: number;
    if (prev && next) {
      if (pLast === nLast) lastUsedOn = (pLast ?? 0) - 10000;
      else lastUsedOn = Math.floor(((pLast ?? 0) + (nLast ?? 0)) / 2);
    } else if (prev) {
      lastUsedOn = (pLast ?? 0) - 10000;
    } else if (next) {
      lastUsedOn = (nLast ?? 0) + 10000;
    } else {
      lastUsedOn = Date.now();
    }
    const item = { stickerPackId: items[to].id, lastUsedOn };
    this.preferences.upsertPackOrderItem(item);
    this.pendingOrder = item;
    await this.saveOrder();
  }

  protected async saveOrder() {
    if (!this.pendingOrder || this.savingOrder()) return;
    this.savingOrder.set(true);
    this.orderFailed.set(false);
    try {
      const success = await this.preferences.syncPackOrder([this.pendingOrder]);
      this.orderFailed.set(!success);
      if (success) {
        this.preferences.upsertPackOrderItem(this.pendingOrder);
        this.pendingOrder = undefined;
      }
    } finally {
      this.savingOrder.set(false);
    }
  }
  panelResume() {
    void this.load();
  }
}
