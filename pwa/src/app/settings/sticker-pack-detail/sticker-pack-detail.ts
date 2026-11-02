import { HttpClient } from '@angular/common/http';
import { Component, computed, DestroyRef, effect, inject, input, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
} from '@ionic/angular';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { chevronBackOutline, createOutline, trashOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import { CHAHUA_BASE_URL } from '../../../generated/endpoints/chahua.base-url';
import type { StickerPackDetailResponse, StickerSummary } from '../../../generated/models';
import { decodeId, type SnowflakeID } from '../../api/snowflake-id';
import { MediaLoaded } from '../../messages/media-loaded';
import { appendSticker, removePackSticker, StickerUpdates } from '../../messages/sticker-updates';
import { detectFileMimeType, isHeicLikeMedia, withDetectedMimeType } from '../../messages/media-processing/file-type';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { ContentScrollbars } from '../../scrolling/content-scrollbars';
import { SessionStore } from '../../session/session-store';
import { LoadError } from '../../ui/load-error/load-error';
import { StickerEditor, type StickerEditorValue } from '../sticker-editor/sticker-editor';
import { StickerPreferences } from '../sticker-preferences';

@Component({
  selector: 'app-sticker-pack-detail',
  templateUrl: './sticker-pack-detail.html',
  styleUrl: '../settings/settings.scss',
  imports: [
    StickerEditor,
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
  private readonly api = inject(RpcApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly updates = inject(StickerUpdates);
  private readonly transloco = inject(TranslocoService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(CHAHUA_BASE_URL);
  private readonly alerts = inject(AlertController);
  protected readonly panels = inject(PanelNavigation);
  protected readonly session = inject(SessionStore);
  private readonly preferences = inject(StickerPreferences);
  protected readonly icons = { createOutline, trashOutline };
  protected readonly backIcon = chevronBackOutline;
  protected readonly pack = signal<StickerPackDetailResponse | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly renaming = signal(false);
  private readonly editor = viewChild(StickerEditor);
  protected readonly uploadFile = signal<File | undefined>(undefined);
  protected readonly editorError = signal<string | undefined>(undefined);
  protected readonly error = signal(false);
  protected readonly notice = signal<string | undefined>(undefined);
  protected readonly owned = computed(() => this.pack()?.ownerUid === this.session.user()?.uid);
  private epoch = 0;

  constructor() {
    this.updates.added.pipe(takeUntilDestroyed()).subscribe(({ pack, sticker }) => {
      this.pack.update((current) => (current?.id === pack.id ? appendSticker(current, sticker) : current));
    });
    this.updates.changed.pipe(takeUntilDestroyed()).subscribe((pack) => {
      this.pack.update((current) => (current?.id === pack.id ? pack : current));
    });
    this.updates.stickerRemoved.pipe(takeUntilDestroyed()).subscribe(({ pack, stickerId }) => {
      this.pack.update((current) => (current?.id === pack.id ? removePackSticker(current, stickerId) : current));
    });
    effect(() => void this.load(this.packId()));
  }

  protected retry() {
    return this.load(this.packId());
  }

  private async load(id: SnowflakeID) {
    const epoch = ++this.epoch;
    this.busy.set(true);
    this.error.set(false);
    try {
      const pack = await firstValueFrom(this.updates.getPack(id));
      if (epoch === this.epoch) this.pack.set(pack);
    } catch {
      if (epoch === this.epoch) this.error.set(true);
    } finally {
      if (epoch === this.epoch) this.busy.set(false);
    }
  }

  protected rename() {
    if (!this.pack() || !this.owned() || this.busy()) return;
    this.editorError.set(undefined);
    this.renaming.set(true);
  }

  protected async saveName({ name, visibility }: StickerEditorValue) {
    const pack = this.pack();
    if (!pack || !this.owned() || this.busy() || !name.trim()) return;
    const changes = {
      ...(name.trim() !== pack.name ? { name: name.trim() } : {}),
      ...(visibility != null && visibility !== pack.visibility ? { visibility } : {}),
    };
    if (!Object.keys(changes).length) return;
    const uid = this.session.user()?.uid;
    const epoch = this.epoch;
    const active = () =>
      !this.destroyRef.destroyed &&
      this.session.user()?.uid === uid &&
      this.packId() === pack.id &&
      this.epoch === epoch;
    this.busy.set(true);
    this.editorError.set(undefined);
    try {
      const updated = await firstValueFrom(this.api.stickers.updatePack({ packId: pack.id, ...changes }));
      if (!active()) return;
      this.pack.update(
        (current) =>
          current && {
            ...current,
            name: updated.name,
            visibility: updated.visibility,
            updatedAt: updated.updatedAt,
          },
      );
      this.updates.changed.next(this.pack()!);
      await this.editor()?.dismiss();
      if (active()) this.renaming.set(false);
    } catch {
      if (active()) this.editorError.set(this.transloco.translate('settings.stickerPack.renameFailed'));
    } finally {
      if (active()) this.busy.set(false);
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
      await firstValueFrom(this.api.stickers.deletePack({ packId: pack.id }));
      this.updates.removed.next({ id: pack.id, deleted: true });
      this.preferences.removePackOrderItem(pack.id);
      await this.panels.back();
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
      await firstValueFrom(this.api.stickers.unsubscribeFromPack({ packId: pack.id }));
      this.updates.removed.next({ id: pack.id, deleted: false });
      this.preferences.removePackOrderItem(pack.id);
      await this.panels.back();
    } catch {
      this.busy.set(false);
      this.notice.set(this.transloco.translate('settings.stickerPack.unsubscribeFailed'));
    }
  }

  protected async removeSticker(sticker: StickerSummary) {
    const pack = this.pack();
    if (!pack || this.busy()) return;
    const uid = this.session.user()?.uid;
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
      await firstValueFrom(this.api.stickers.removeFromPack({ packId: pack.id, stickerId: sticker.id }));
      if (this.session.user()?.uid !== uid) return;
      this.updates.stickerRemoved.next({ pack, stickerId: sticker.id });
    } catch {
      if (!this.destroyRef.destroyed && this.session.user()?.uid === uid)
        this.notice.set(this.transloco.translate('settings.stickerPack.removeStickerFailed'));
    } finally {
      if (!this.destroyRef.destroyed && this.session.user()?.uid === uid) this.busy.set(false);
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
    this.editorError.set(undefined);
    this.uploadFile.set(withDetectedMimeType(file, mimeType));
  }

  protected async saveSticker(values: StickerEditorValue) {
    const pack = this.pack();
    const file = this.uploadFile();
    if (!pack || !file || this.busy() || !values.emoji.trim()) return;
    const uid = this.session.user()?.uid;
    this.editorError.set(undefined);
    this.busy.set(true);
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      body.append('emoji', values.emoji.trim());
      if (values.name.trim()) body.append('name', values.name.trim());
      const sticker = await firstValueFrom(
        this.http.post<StickerSummary>(`${this.baseUrl}/stickers/packs/${decodeId(pack.id)}/stickers`, body),
      );
      if (this.destroyRef.destroyed || this.session.user()?.uid !== uid) return;
      this.updates.added.next({ pack, sticker });
      await this.editor()?.dismiss();
      this.uploadFile.set(undefined);
    } catch {
      this.editorError.set(this.transloco.translate('stickers.addFailed'));
    } finally {
      this.busy.set(false);
    }
  }
}
