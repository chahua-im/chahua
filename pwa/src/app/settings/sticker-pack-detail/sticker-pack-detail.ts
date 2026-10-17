import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
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
import {
  detectFileMimeType,
  isHeicLikeMedia,
  withDetectedMimeType,
} from '../../messages/media-processing/file-type';
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
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonSpinner,
    IonTitle,
    IonToast,
    IonToolbar,
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
      header: '重命名贴纸包',
      inputs: [{ name: 'name', type: 'text', value: pack.name, placeholder: '贴纸包名称' }],
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '保存', role: 'confirm' },
      ],
    });
    await alert.present();
    const result = await alert.onDidDismiss<{ values: { name: string } }>();
    const name = result.data?.values.name.trim();
    if (result.role !== 'confirm' || !name || name === pack.name) return;
    this.busy.set(true);
    try {
      this.pack.set(await firstValueFrom(this.api.patchPack(pack.id, { name })));
      this.notice.set('贴纸包已重命名');
    } catch {
      this.notice.set('重命名失败，请重试。');
    } finally {
      this.busy.set(false);
    }
  }

  protected async deletePack() {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    const alert = await this.alerts.create({
      header: '删除贴纸包',
      message: '删除这个贴纸包吗？贴纸本身会保留，但这个贴纸包以及其中的收录关系将被移除。',
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '删除', role: 'destructive' },
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
      this.notice.set('删除失败，请重试。');
    }
  }

  protected async unsubscribe() {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    const alert = await this.alerts.create({
      header: '取消订阅',
      message: '要将这个表情包从你的收藏中移除吗？',
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '取消订阅', role: 'destructive' },
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
      this.notice.set('取消订阅失败，请重试。');
    }
  }

  protected async removeSticker(sticker: StickerSummary) {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    const alert = await this.alerts.create({
      header: '移除贴纸',
      message: '要从表情包中移除此表情吗？',
      buttons: [
        { text: '取消', role: 'cancel' },
        { text: '移除', role: 'destructive' },
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
      this.notice.set('移除失败，请重试。');
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
        header: '无法添加贴纸',
        message: '请选择 10 MB 以内的图片或 WebM 视频。',
        buttons: ['知道了'],
      });
      await invalid.present();
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
      this.notice.set('贴纸已添加');
    } catch {
      this.notice.set('添加表情失败');
    } finally {
      this.busy.set(false);
    }
  }
}
