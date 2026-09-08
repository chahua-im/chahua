import { NgTemplateOutlet } from '@angular/common';
import { heart, cubeOutline } from 'ionicons/icons';
import { Component, inject, signal, input, effect, output, DestroyRef } from '@angular/core';
import {
  IonIcon,
  IonPopover,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
  IonButton,
  IonContent,
  IonList,
  IonItem,
  IonLabel,
  IonSpinner,
  ModalController,
} from '@ionic/angular';
import { firstValueFrom } from 'rxjs';
import { StickersService } from '../../../generated/endpoints/stickers/stickers.service';
import {
  MessageType,
  type StickerSummary,
  type StickerPackSummary,
  type StickerPackDetailResponse,
  type SnowflakeID,
} from '../../../generated/models';
import { MessageAttachments } from '../message-attachments/message-attachments';
import { ContentScrollbars } from '../../content-scrollbars';
@Component({
  selector: 'app-sticker-picker',
  templateUrl: './sticker-picker.html',
  styleUrl: './sticker-picker.scss',
  imports: [
    ContentScrollbars,
    IonIcon,
    IonPopover,
    NgTemplateOutlet,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonSpinner,
    MessageAttachments,
  ],
  host: { '[class.ion-page]': '!embedded()', '[class.embedded]': 'embedded()' },
})
export class StickerPicker {
  readonly selectable = input(true);
  readonly embedded = input(false);
  readonly disabled = input(false);
  readonly selected = output<StickerSummary>();
  protected readonly icons = { heart, cubeOutline };
  protected readonly menu = signal<{ sticker: StickerSummary; event: Event } | undefined>(undefined);
  private hold?: { timer: ReturnType<typeof setTimeout>; x: number; y: number };
  private longPressed = false;
  readonly packId = input<SnowflakeID>();
  readonly stickerId = input<SnowflakeID>();
  protected readonly modals = inject(ModalController);
  private readonly api = inject(StickersService);
  protected readonly packs = signal<StickerPackSummary[]>([]);
  protected readonly pack = signal<StickerPackDetailResponse | undefined>(undefined);
  protected readonly stickers = signal<StickerSummary[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal(false);
  protected readonly Type = MessageType;
  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancelHold());
    effect(() => {
      const pack = this.packId();
      const sticker = this.stickerId();
      if (pack) void this.openPack(pack);
      else if (sticker) void this.openSticker(sticker);
      else void this.load();
    });
  }
  protected async load() {
    this.busy.set(true);
    this.error.set(false);
    this.pack.set(undefined);
    try {
      const [favorites, subscribed, owned] = await Promise.all([
        firstValueFrom(this.api.getMyFavorites()),
        firstValueFrom(this.api.getMySubscribedPacks()),
        firstValueFrom(this.api.getMyOwnedPacks()),
      ]);
      this.stickers.set(favorites.stickers);
      this.packs.set([...new Map([...subscribed.packs, ...owned.packs].map((pack) => [pack.id, pack])).values()]);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async openPack(id: SnowflakeID) {
    this.busy.set(true);
    this.error.set(false);
    try {
      const pack = await firstValueFrom(this.api.getPack(id));
      this.pack.set(pack);
      this.stickers.set(pack.stickers);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  private async openSticker(id: SnowflakeID) {
    this.busy.set(true);
    try {
      const sticker = await firstValueFrom(this.api.getSticker(id));
      this.stickers.set([sticker]);
      this.packs.set(sticker.packs);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async favorite(sticker: StickerSummary) {
    this.busy.set(true);
    this.error.set(false);
    try {
      await firstValueFrom(
        sticker.isFavorited ? this.api.deleteFavorite(sticker.id) : this.api.putFavorite(sticker.id),
      );
      this.stickers.update((items) =>
        items.map((item) => (item.id === sticker.id ? { ...item, isFavorited: !item.isFavorited } : item)),
      );
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async subscribe() {
    const pack = this.pack();
    if (!pack) return;
    this.busy.set(true);
    try {
      await firstValueFrom(
        pack.isSubscribed ? this.api.deleteSubscription(pack.id) : this.api.putSubscription(pack.id),
      );
      this.pack.set({ ...pack, isSubscribed: !pack.isSubscribed });
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected send(sticker: StickerSummary) {
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    if (this.disabled() || this.busy() || !this.selectable()) return;
    if (this.embedded()) this.selected.emit(sticker);
    else void this.modals.dismiss(sticker, 'send');
  }
  protected press(sticker: StickerSummary, event: PointerEvent) {
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
