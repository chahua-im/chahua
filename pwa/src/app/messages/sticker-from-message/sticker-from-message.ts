import { RpcError, RpcErrorCode, RpcTransportError } from '../../api/rpc-error';
import { Component, computed, DestroyRef, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { IonButton, IonItem, IonNote, IonSelect, IonSelectOption } from '@ionic/angular';
import { TranslocoPipe, translateSignal } from '@jsverse/transloco';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { RpcApi } from '../../../generated/rpc-api';
import type { MessageResponse, StickerPackSummary } from '../../../generated/models';
import type { SnowflakeID } from '../../api/snowflake-id';
import { SessionStore } from '../../session/session-store';
import { StickerEditor, type StickerEditorValue } from '../../settings/sticker-editor/sticker-editor';
import { sortStickerPacksByPreference, StickerPreferences } from '../../settings/sticker-preferences';
import { StickerUpdates } from '../sticker-updates';
import { canCreateSticker } from './eligibility';

@Component({
  selector: 'app-sticker-from-message',
  templateUrl: './sticker-from-message.html',
  imports: [StickerEditor, TranslocoPipe, IonButton, IonItem, IonNote, IonSelect, IonSelectOption],
  styles: `
    .preview {
      display: block;
      width: 160px;
      height: 160px;
      object-fit: contain;
      margin: 8px auto;
    }
  `,
})
export class StickerFromMessage {
  readonly message = input.required<MessageResponse>();
  readonly packs = input.required<readonly StickerPackSummary[]>();
  readonly closed = output<void>();
  readonly saved = output<void>();
  private readonly api = inject(RpcApi);
  private readonly updates = inject(StickerUpdates);
  private readonly preferences = inject(StickerPreferences);
  private readonly session = inject(SessionStore);
  private readonly uid = this.session.user()?.uid;
  private readonly destroy = inject(DestroyRef);
  private readonly editor = viewChild.required<StickerEditor>('stickerEditor');
  private readonly packEditor = viewChild<StickerEditor>('packEditor');
  private readonly createdPacks = signal<StickerPackSummary[]>([]);
  private completed = false;
  protected readonly orderedPacks = computed(() =>
    sortStickerPacksByPreference([...this.packs(), ...this.createdPacks()], this.preferences.packOrder()),
  );
  protected readonly packId = linkedSignal<StickerPackSummary[], SnowflakeID | undefined>({
    source: this.orderedPacks,
    computation: (packs, previous) => {
      const selected = previous?.value;
      return packs.some((pack) => pack.id === selected) ? selected : packs[0]?.id;
    },
  });
  protected readonly busy = signal(false);
  protected readonly createOpen = signal(false);
  protected readonly creatingPack = signal(false);
  protected readonly createFailed = signal(false);
  protected readonly errorKey = signal<string | undefined>(undefined);
  protected readonly errorText = translateSignal(computed(() => this.errorKey() ?? 'stickers.addFailed'));
  protected readonly saveDisabled = computed(
    () => this.createOpen() || !canCreateSticker(this.message()) || !this.packId(),
  );

  protected createPack() {
    if (this.busy() || !this.active()) return;
    this.createFailed.set(false);
    this.createOpen.set(true);
  }

  protected async savePack({ name }: StickerEditorValue) {
    if (this.creatingPack() || !name.trim() || !this.active()) return;
    this.creatingPack.set(true);
    this.createFailed.set(false);
    try {
      const pack = await firstValueFrom(this.api.stickers.createPack({ name: name.trim() }));
      if (!this.active()) return;
      this.createdPacks.update((packs) => [...packs, pack]);
      this.updates.changed.next({ ...pack, stickers: [] });
      this.preferences.upsertPackOrderItem({ stickerPackId: pack.id, lastUsedOn: Date.now() });
      this.packId.set(pack.id);
      this.errorKey.set(undefined);
      await this.packEditor()?.dismiss();
      if (this.active()) this.createOpen.set(false);
    } catch {
      if (this.active()) this.createFailed.set(true);
    } finally {
      if (this.active()) this.creatingPack.set(false);
    }
  }

  private active() {
    return !this.destroy.destroyed && this.session.user()?.uid === this.uid;
  }

  protected dismissed() {
    if (this.completed && this.active()) this.saved.emit();
    this.closed.emit();
  }

  protected async save(values: StickerEditorValue) {
    if (this.busy() || this.saveDisabled() || !this.active()) return;
    const pack = this.orderedPacks().find((item) => item.id === this.packId());
    if (!pack) return;
    this.busy.set(true);
    this.errorKey.set(undefined);
    try {
      const source = this.message();
      const sticker = await firstValueFrom(
        this.api.stickers
          .createFromMessage({
            packId: pack.id,
            chatId: source.chatId,
            messageId: source.id,
            emoji: values.emoji,
            ...(values.name ? { name: values.name } : {}),
          })
          .pipe(timeout(60000)),
      );
      if (!this.active()) return;
      this.updates.added.next({ pack, sticker });
      this.completed = true;
      await this.editor().dismiss();
    } catch (error) {
      if (!this.active()) return;
      const code = error instanceof RpcError ? error.code : undefined;
      this.errorKey.set(
        error instanceof TimeoutError || error instanceof RpcTransportError
          ? 'stickers.fromMessage.uncertain'
          : code === RpcErrorCode.BadRequest
            ? 'stickers.fromMessage.invalid'
            : code === RpcErrorCode.Forbidden
              ? 'stickers.fromMessage.forbidden'
              : code === RpcErrorCode.NotFound
                ? 'stickers.fromMessage.missing'
                : code === RpcErrorCode.Conflict
                  ? 'stickers.fromMessage.changed'
                  : 'stickers.addFailed',
      );
    } finally {
      if (this.active()) this.busy.set(false);
    }
  }
}
