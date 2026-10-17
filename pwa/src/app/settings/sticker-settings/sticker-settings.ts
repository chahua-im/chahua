import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ItemReorderEventDetail } from '@ionic/angular';
import {
  AlertController,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonPopover,
  IonReorder,
  IonReorderGroup,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { addOutline, chevronBackOutline, cubeOutline, happyOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { StickersService } from '../../../generated/endpoints/stickers/stickers.service';
import type { StickerPackSummary } from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { EmojiPicker } from '../../messages/emoji-picker/emoji-picker';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { LoadError } from '../../ui/load-error/load-error';
import { Preferences } from '../preferences';
import { extractEmojiSequences } from '../emoji-sequences';
import { AUTO_SORT_LIMIT, StickerPreferences, sortStickerPacksByPreference } from '../sticker-preferences';

@Component({
  selector: 'app-sticker-settings',
  templateUrl: './sticker-settings.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    ContentScrollbars,
    EmojiPicker,
    LoadError,
    IonBadge,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonInput,
    IonItem,
    IonLabel,
    IonList,
    IonPopover,
    IonReorder,
    IonReorderGroup,
    IonSpinner,
    IonTitle,
    IonToggle,
    IonToolbar,
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
      font-size: 0.55rem;
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
      font-size: 10px;
      padding: 2px 8px;
      margin: 4px 0;
      color: var(--ion-color-medium);
      background: var(--ion-item-background, var(--ion-background-color, #fff));
      border-radius: 12px;
    }
  `,
})
export class StickerSettings {
  private readonly api = inject(StickersService);
  private readonly alerts = inject(AlertController);
  private readonly router = inject(Router);
  protected readonly modals = inject(ModalController);
  protected readonly preferences = inject(StickerPreferences);
  protected readonly reactions = inject(Preferences);
  protected readonly icons = { happyOutline, addOutline, cubeOutline };
  protected readonly backIcon = chevronBackOutline;
  protected readonly autoSortLimit = AUTO_SORT_LIMIT;
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly choosingPinned = signal(false);
  private readonly owned = signal<StickerPackSummary[]>([]);
  private readonly packs = signal<StickerPackSummary[]>([]);
  protected readonly ownedIds = computed(() => new Set(this.owned().map((pack) => pack.id)));
  protected readonly orderedPacks = computed(() =>
    sortStickerPacksByPreference(this.packs(), this.preferences.packOrder()),
  );
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

  protected editPinned(event: Event) {
    const value = String((event.target as HTMLIonInputElement).value ?? '');
    this.reactions.setPinnedReactions(extractEmojiSequences(value));
  }

  protected addPinned(emoji: string) {
    const pinned = this.reactions.pinnedReactions();
    if (pinned.includes(emoji) || pinned.length >= 5) return;
    this.reactions.setPinnedReactions([...pinned, emoji]);
  }

  protected async createPack() {
    const alert = await this.alerts.create({
      header: '创建贴纸包',
      inputs: [{ name: 'name', placeholder: '名称' }],
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '创建', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss<{ values: { name: string } }>();
    const name = result.data?.values.name.trim();
    if (result.role !== 'confirm' || !name) return;
    try {
      const pack = await firstValueFrom(this.api.postPack({ name }));
      this.owned.update((owned) => [...owned, pack]);
      this.packs.update((packs) => [pack, ...packs]);
      this.preferences.upsertPackOrderItem({ stickerPackId: pack.id, lastUsedOn: Date.now() });
      await this.router.navigate(['/settings/stickers', decodeId(pack.id)]);
    } catch {
      const failure = await this.alerts.create({ header: '创建贴纸包失败', buttons: ['知道了'] });
      await failure.present();
    }
  }

  protected openPack(pack: StickerPackSummary) {
    if (Date.now() - this.lastReorder < 300) return;
    return this.router.navigate(['/settings/stickers', decodeId(pack.id)]);
  }

  protected reorder(event: CustomEvent<ItemReorderEventDetail>) {
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
    void this.preferences.syncPackOrder([item]);
  }
}
