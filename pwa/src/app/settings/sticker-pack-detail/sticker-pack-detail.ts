import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonProgressBar,
  IonSpinner,
  IonTitle,
  IonToast,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { chevronBackOutline, createOutline, trashOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { CHAHUA_BASE_URL } from '../../../generated/endpoints/chahua.base-url';
import { StickersService } from '../../../generated/endpoints/stickers/stickers.service';
import type { StickerPackDetailResponse, StickerSummary } from '../../../generated/models';
import { decodeId, type SnowflakeID } from '../../api/snowflake-id';
import { MediaLoaded } from '../../messages/media-loaded';
import { detectFileMimeType, isHeicLikeMedia, withDetectedMimeType } from '../../messages/media-processing/file-type';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { LoadError } from '../../ui/load-error/load-error';
import { StickerPreferences } from '../sticker-preferences';

@Component({
  selector: 'app-sticker-pack-detail',
  templateUrl: './sticker-pack-detail.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    ContentScrollbars,
    LoadError,
    MediaLoaded,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonProgressBar,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToolbar,
    TranslocoPipe,
  ],
  host: { class: 'ion-page' },
  styles: `
    .hint {
      padding: 8px 16px;
      color: var(--ion-color-medium);
      font-size: 0.85em;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
      gap: 8px;
      padding: 8px 16px 16px;
    }
    .cell {
      position: relative;
      aspect-ratio: 1;
      border-radius: 8px;
      background: none;
      padding: 0;
    }
    .cell img,
    .cell video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    .cell.add {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      color: var(--ion-color-medium);
      border: 2px dashed var(--ion-color-light-shade);
    }
    // Covers one cell until its own image or first video frame paints.
    .cell-skeleton {
      position: absolute;
      inset: 6px;
      border-radius: 8px;
    }
    .cell:has(.loaded) .cell-skeleton {
      display: none;
    }
    .cell .remove {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 20px;
      height: 20px;
      line-height: 20px;
      border-radius: 50%;
      background: var(--ion-color-danger);
      color: var(--ion-color-danger-contrast);
      font-size: 12px;
      text-align: center;
    }
    .loading-status {
      display: flex;
      justify-content: center;
      padding: 24px;
    }
  `,
})
export class StickerPackDetail {
  readonly packId = input.required<SnowflakeID>();
  private readonly api = inject(StickersService);
  private readonly transloco = inject(TranslocoService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(CHAHUA_BASE_URL);
  private readonly alerts = inject(AlertController);
  protected readonly modals = inject(ModalController);
  protected readonly session = inject(SessionStore);
  private readonly preferences = inject(StickerPreferences);
  protected readonly icons = { createOutline, trashOutline };
  protected readonly backIcon = chevronBackOutline;
  protected readonly pack = signal<StickerPackDetailResponse | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly error = signal(false);
  protected readonly notice = signal<string | undefined>(undefined);
  protected readonly owned = computed(() => this.pack()?.ownerUid === this.session.user()?.uid);

  constructor() {
    effect(() => void this.load(this.packId()));
  }

  protected retry() {
    return this.load(this.packId());
  }

  private async load(id: SnowflakeID) {
    this.busy.set(true);
    this.error.set(false);
    try {
      this.pack.set(await firstValueFrom(this.api.getPack(id)));
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  protected async rename() {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    const alert = await this.alerts.create({
      header: this.transloco.translate('settings.stickerPack.renameTitle'),
      inputs: [
        {
          name: 'name',
          type: 'text',
          value: pack.name,
          placeholder: this.transloco.translate('settings.stickerPack.namePlaceholder'),
        },
      ],
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('common.save'), role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss<{ values: { name: string } }>();
    const name = result.data?.values.name.trim();
    if (result.role !== 'confirm' || !name || name === pack.name) return;
    this.busy.set(true);
    try {
      this.pack.set(await firstValueFrom(this.api.patchPack(pack.id, { name })));
      this.notice.set(this.transloco.translate('settings.stickerPack.renamed'));
    } catch {
      this.notice.set(this.transloco.translate('settings.stickerPack.renameFailed'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async deletePack() {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    const alert = await this.alerts.create({
      header: this.transloco.translate('settings.stickerPack.deleteTitle'),
      message: this.transloco.translate('settings.stickerPack.deleteMessage'),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('common.delete'), role: 'destructive' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'destructive') return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.deletePack(pack.id));
      this.preferences.removePackOrderItem(pack.id);
      await this.modals.dismiss();
    } catch {
      this.busy.set(false);
      this.notice.set(this.transloco.translate('settings.stickerPack.deleteFailed'));
    }
  }

  protected async unsubscribe() {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    const alert = await this.alerts.create({
      header: this.transloco.translate('settings.stickerPack.unsubscribe'),
      message: this.transloco.translate('settings.stickerPack.unsubscribeMessage'),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('settings.stickerPack.unsubscribe'), role: 'destructive' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'destructive') return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.deleteSubscription(pack.id));
      this.preferences.removePackOrderItem(pack.id);
      await this.modals.dismiss();
    } catch {
      this.busy.set(false);
      this.notice.set(this.transloco.translate('settings.stickerPack.unsubscribeFailed'));
    }
  }

  protected async removeSticker(sticker: StickerSummary) {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    const alert = await this.alerts.create({
      header: this.transloco.translate('settings.stickerPack.removeStickerTitle'),
      message: this.transloco.translate('settings.stickerPack.removeStickerMessage'),
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('common.remove'), role: 'destructive' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'destructive') return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.deletePackSticker(pack.id, sticker.id));
      const current = this.pack();
      if (current)
        this.pack.set({
          ...current,
          stickerCount: current.stickerCount - 1,
          stickers: current.stickers.filter((item) => item.id !== sticker.id),
        });
    } catch {
      this.notice.set(this.transloco.translate('settings.stickerPack.removeStickerFailed'));
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
      const invalid = await this.alerts.create({
        header: this.transloco.translate('stickers.invalidUploadTitle'),
        message: this.transloco.translate('stickers.invalidUploadMessage'),
        buttons: [this.transloco.translate('common.ok')],
      });
      await invalid.present();
      return;
    }
    const alert = await this.alerts.create({
      header: this.transloco.translate('stickers.addTitle'),
      inputs: [
        { name: 'emoji', placeholder: this.transloco.translate('stickers.emojiPlaceholder') },
        { name: 'name', placeholder: this.transloco.translate('stickers.optionalName') },
      ],
      buttons: [
        { text: this.transloco.translate('common.cancel'), role: 'cancel' },
        { text: this.transloco.translate('common.upload'), role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss<{ values: { emoji: string; name: string } }>();
    const values = result.data?.values;
    if (result.role !== 'confirm' || !values?.emoji.trim()) return;
    this.busy.set(true);
    try {
      const body = new FormData();
      body.append('file', withDetectedMimeType(file, mimeType), file.name);
      body.append('emoji', values.emoji.trim());
      if (values.name.trim()) body.append('name', values.name.trim());
      const sticker = await firstValueFrom(
        this.http.post<StickerSummary>(`${this.baseUrl}/stickers/packs/${decodeId(pack.id)}/stickers`, body),
      );
      const current = this.pack();
      if (current)
        this.pack.set({
          ...current,
          stickerCount: current.stickerCount + 1,
          stickers: [...current.stickers, sticker],
        });
      this.notice.set(this.transloco.translate('stickers.added'));
    } catch {
      this.notice.set(this.transloco.translate('stickers.addFailed'));
    } finally {
      this.busy.set(false);
    }
  }
}
