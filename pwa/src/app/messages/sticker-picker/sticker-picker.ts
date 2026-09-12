import { NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, DestroyRef, effect, inject, input, linkedSignal, output, signal } from '@angular/core';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonFooter,
  IonGrid,
  IonRow,
  IonCol,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { addOutline, cloudUploadOutline, cubeOutline, heart } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { CHAHUA_BASE_URL } from '../../../generated/endpoints/chahua.base-url';
import { StickersService } from '../../../generated/endpoints/stickers/stickers.service';
import type {
  SnowflakeID,
  StickerPackDetailResponse,
  StickerPackSummary,
  StickerSummary,
} from '../../../generated/models';
import { decodeId } from '../../api/snowflake-id';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { detectFileMimeType, isHeicLikeMedia, withDetectedMimeType } from '../media-processing/file-type';
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
    IonFooter,
    IonGrid,
    IonRow,
    IonCol,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonSpinner,
  ],
  host: { '[class.ion-page]': '!embedded()', '[class.embedded]': 'embedded()' },
})
export class StickerPicker {
  readonly selectable = input(true);
  readonly embedded = input(false);
  readonly selected = output<StickerSummary>();
  protected readonly icons = { heart, cubeOutline, addOutline, cloudUploadOutline };
  protected readonly session = inject(SessionStore);
  private readonly alerts = inject(AlertController);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(CHAHUA_BASE_URL);
  protected readonly menu = signal<{ sticker: StickerSummary; event: Event } | undefined>(undefined);
  private hold?: { timer: ReturnType<typeof setTimeout>; x: number; y: number };
  private longPressed = false;
  readonly packId = input<SnowflakeID>();
  readonly stickerId = input<SnowflakeID>();
  protected readonly modals = inject(ModalController);
  private readonly api = inject(StickersService);
  protected readonly packs = signal<StickerPackSummary[]>([]);
  private readonly content = signal<StickerPackDetailResponse | { stickers: StickerSummary[] }>({ stickers: [] });
  protected readonly pack = computed(() => {
    const content = this.content();
    return 'id' in content ? content : undefined;
  });
  protected readonly stickers = computed(() => this.content().stickers);
  private readonly chosenId = linkedSignal(() => this.stickerId());
  protected readonly chosen = computed(
    () => this.stickers().find((sticker) => sticker.id === this.chosenId()) ?? this.stickers().at(0),
  );
  protected readonly busy = signal(false);
  protected readonly error = signal(false);
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
    this.busy.set(true);
    this.error.set(false);
    try {
      const pack = await firstValueFrom(this.api.postPack({ name }));
      this.content.set(pack);
      this.packs.update((packs) => [...packs, pack]);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async upload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const pack = this.pack();
    if (!file || !pack || this.busy()) return;
    const mimeType = await detectFileMimeType(file);
    if (
      (!mimeType.startsWith('image/') && mimeType !== 'video/webm') ||
      isHeicLikeMedia({ mimeType, fileName: file.name }) ||
      file.size > 10 * 1024 * 1024
    ) {
      const alert = await this.alerts.create({
        header: '无法添加贴纸',
        message: '请选择 10 MB 以内的图片或 WebM 视频。',
        buttons: ['知道了'],
      });
      await alert.present();
      return;
    }
    const alert = await this.alerts.create({
      header: '添加贴纸',
      inputs: [
        { name: 'emoji', placeholder: '对应表情，例如 🙂' },
        { name: 'name', placeholder: '名称（选填）' },
      ],
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '上传', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss<{ values: { emoji: string; name: string } }>();
    const values = result.data?.values;
    if (result.role !== 'confirm' || !values?.emoji.trim()) return;
    this.busy.set(true);
    this.error.set(false);
    try {
      const body = new FormData();
      body.append('file', withDetectedMimeType(file, mimeType), file.name);
      body.append('emoji', values.emoji.trim());
      if (values.name.trim()) body.append('name', values.name.trim());
      await firstValueFrom(this.http.post(`${this.baseUrl}/stickers/packs/${decodeId(pack.id)}/stickers`, body));
      await this.openPack(pack.id);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async load() {
    this.busy.set(true);
    this.error.set(false);
    try {
      const [favorites, subscribed, owned] = await Promise.all([
        firstValueFrom(this.api.getMyFavorites()),
        firstValueFrom(this.api.getMySubscribedPacks()),
        firstValueFrom(this.api.getMyOwnedPacks()),
      ]);
      this.content.set({ stickers: favorites.stickers });
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
      this.content.set(pack);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  private async openSticker(id: SnowflakeID) {
    this.busy.set(true);
    this.error.set(false);
    try {
      const sticker = await firstValueFrom(this.api.getSticker(id));
      const pack = sticker.packs[0];
      this.content.set(pack ? await firstValueFrom(this.api.getPack(pack.id)) : { stickers: [sticker] });
      this.packs.set(sticker.packs);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected retry() {
    const pack = this.pack()?.id ?? this.packId();
    const sticker = this.stickerId();
    return pack ? this.openPack(pack) : sticker ? this.openSticker(sticker) : this.load();
  }
  protected async favorite(sticker: StickerSummary) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(false);
    try {
      await firstValueFrom(
        sticker.isFavorited ? this.api.deleteFavorite(sticker.id) : this.api.putFavorite(sticker.id),
      );
      this.content.update((content) => ({
        ...content,
        stickers: content.stickers.map((item) =>
          item.id === sticker.id ? { ...item, isFavorited: !item.isFavorited } : item,
        ),
      }));
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
  protected async subscribe() {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    this.busy.set(true);
    this.error.set(false);
    try {
      await firstValueFrom(
        pack.isSubscribed ? this.api.deleteSubscription(pack.id) : this.api.putSubscription(pack.id),
      );
      this.content.set({ ...pack, isSubscribed: !pack.isSubscribed });
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
    if (!this.selectable()) {
      this.chosenId.set(sticker.id);
      return;
    }
    if (this.embedded()) this.selected.emit(sticker);
    else void this.modals.dismiss(sticker, 'send');
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
