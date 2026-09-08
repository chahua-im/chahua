import { ElementRef } from '@angular/core';
import { VoiceRecorder } from '../voice-recorder/voice-recorder';
import { prepareMedia } from '../media-processing/prepare-media';
import { mayBeMediaFile } from '../media-processing/file-type';
import { displayText, editText, wireText } from './mention-text';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
  DestroyRef,
  untracked,
} from '@angular/core';
import { IonButton, IonIcon, IonTextarea, IonSpinner, IonList, IonItem, IonLabel } from '@ionic/angular';
import { addCircleOutline, happyOutline, send, closeOutline, imageOutline, documentOutline } from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { AttachmentsService } from '../../../generated/endpoints/attachments/attachments.service';
import { MembersService } from '../../../generated/endpoints/members/members.service';
import {
  AttachmentUploadPurpose,
  MessageType,
  UserSearchMode,
  type AttachmentResponse,
  type MemberResponse,
  type MessageResponse,
  type SnowflakeID,
  type StickerSummary,
} from '../../../generated/models';
import { uploadBlob } from '../upload';
import { StickerPicker } from '../sticker-picker/sticker-picker';
export interface Composition {
  messageType: MessageType;
  attachmentIds: SnowflakeID[];
  sticker?: StickerSummary;
}
enum Panel {
  None,
  Attachments,
  Stickers,
}
enum UploadStatus {
  Processing,
  Uploading,
  Ready,
  Failed,
}
interface Upload {
  file: File;
  prepared?: Awaited<ReturnType<typeof prepareMedia>>;
  url: string;
  status: UploadStatus;
  progress: number;
  id?: SnowflakeID;
  controller: AbortController;
  purpose: AttachmentUploadPurpose;
}
@Component({
  selector: 'app-message-composer',
  templateUrl: './message-composer.html',
  styleUrl: './message-composer.scss',
  imports: [IonButton, IonIcon, IonTextarea, IonSpinner, IonList, IonItem, IonLabel, StickerPicker, VoiceRecorder],
  host: { '(document:click)': 'outside($event)' },
})
export class MessageComposer {
  readonly text = model('');
  readonly chatId = input.required<SnowflakeID>();
  readonly disabled = input(false);
  readonly editing = input<MessageResponse>();
  readonly submitted = output<Composition>();
  protected readonly icons = { addCircleOutline, happyOutline, send, closeOutline, imageOutline, documentOutline };
  protected readonly Status = UploadStatus;
  private readonly api = inject(AttachmentsService);
  private readonly members = inject(MembersService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly voice = viewChild(VoiceRecorder);
  protected readonly Panel = Panel;
  protected readonly Purpose = AttachmentUploadPurpose;
  protected readonly panel = signal(Panel.None);
  readonly voiceActive = signal(false);
  private readonly destroy = inject(DestroyRef);
  private readonly textarea = viewChild(IonTextarea);
  protected readonly uploads = signal<Upload[]>([]);
  protected readonly existing = signal<AttachmentResponse[]>([]);
  protected readonly error = signal(false);
  protected readonly suggestions = signal<MemberResponse[]>([]);
  protected readonly tooMany = signal(false);
  protected readonly unsupported = signal(false);
  private mentionVersion = 0;
  private mentionRange?: { start: number; end: number };
  private readonly mentionNames = signal(new Map<number, string>());
  protected readonly display = computed(() =>
    displayText(
      this.text(),
      new Map([
        ...this.mentionNames(),
        ...(this.editing()?.mentions ?? []).filter((m) => m.username).map((m) => [m.uid, m.username!] as const),
      ]),
    ),
  );
  protected readonly uploading = computed(() => this.uploads().some((u) => u.status !== UploadStatus.Ready));
  protected readonly canSend = computed(
    () =>
      !this.disabled() &&
      !this.uploading() &&
      !this.voiceActive() &&
      (!!this.text().trim() || !!this.existing().length || !!this.uploads().length),
  );
  protected readonly pendingUpload = computed(() =>
    this.uploads().some((u) => u.status === UploadStatus.Processing || u.status === UploadStatus.Uploading),
  );
  protected readonly visualUploads = computed(() =>
    this.uploads().filter((u) => u.purpose !== AttachmentUploadPurpose.voice),
  );
  protected readonly useVoice = computed(
    () => !this.editing() && !this.text().trim() && !this.existing().length && !this.visualUploads().length,
  );
  protected async togglePanel(panel: Panel) {
    this.panel.set(this.panel() === panel ? Panel.None : panel);
    if (this.panel() !== Panel.None) (await this.textarea()?.getInputElement())?.blur();
  }
  protected outside(event: Event) {
    const target = event.target as HTMLElement;
    if (
      this.panel() !== Panel.None &&
      !this.host.nativeElement.contains(target) &&
      !target.closest('ion-modal,ion-popover,ion-alert,ion-action-sheet')
    )
      this.panel.set(Panel.None);
  }
  constructor() {
    effect(() => {
      this.chatId();
      const message = this.editing();
      untracked(() => {
        this.reset();
        this.existing.set(message?.attachments ?? []);
      });
    });
    this.destroy.onDestroy(() => this.reset());
  }
  setFocus() {
    return this.textarea()?.setFocus();
  }
  reset() {
    for (const upload of this.uploads()) {
      upload.controller.abort();
      URL.revokeObjectURL(upload.url);
    }
    this.uploads.set([]);
    this.existing.set([]);
    this.voice()?.reset();
    this.panel.set(Panel.None);
    this.mentionVersion++;
    this.mentionRange = undefined;
    this.suggestions.set([]);
    this.error.set(false);
    this.tooMany.set(false);
    this.unsupported.set(false);
  }
  protected files(event: Event, purpose: AttachmentUploadPurpose) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.panel.set(Panel.None);
    for (const file of files) void this.addFile(file, purpose);
  }

  protected async paste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files)
      void this.addFile(file, mayBeMediaFile(file) ? AttachmentUploadPurpose.media : AttachmentUploadPurpose.file);
  }
  private async addFile(file: File, purpose: AttachmentUploadPurpose) {
    if (this.uploads().length + this.existing().length >= 20) {
      this.tooMany.set(true);
      return;
    }
    if (this.editing() && purpose !== AttachmentUploadPurpose.media) {
      this.unsupported.set(true);
      return;
    }
    const upload: Upload = {
      file,
      purpose,
      url: URL.createObjectURL(file),
      status: UploadStatus.Uploading,
      progress: 0,
      controller: new AbortController(),
    };
    this.uploads.update((items) => [...items, upload]);
    await this.retryUpload(upload);
    return upload;
  }
  protected async retryUpload(upload: Upload) {
    this.update(upload, { status: UploadStatus.Uploading, progress: 0 });
    this.error.set(false);
    try {
      const config = await firstValueFrom(this.api.getConfig());
      if (upload.purpose === AttachmentUploadPurpose.media && !upload.prepared) {
        this.update(upload, { status: UploadStatus.Processing, progress: 0 });
        upload.prepared = await prepareMedia(upload.file, upload.controller.signal, (progress) =>
          this.update(upload, { progress }),
        );
      }
      if (upload.controller.signal.aborted) return;
      const { file, dimensions } = upload.prepared ?? { file: upload.file, dimensions: undefined };
      if (file.size > config.maxFileSizeBytes) throw new Error('文件过大');
      this.update(upload, { status: UploadStatus.Uploading, progress: 0 });
      const response = await firstValueFrom(
        this.api.postUploadUrl({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          purpose: upload.purpose,
          ...dimensions,
        }),
      );
      await uploadBlob(response.uploadUrl, file, response.uploadHeaders, upload.controller.signal, (progress) =>
        this.update(upload, { progress }),
      );
      this.update(upload, { id: response.attachmentId, status: UploadStatus.Ready, progress: 1 });
    } catch {
      if (!upload.controller.signal.aborted) {
        this.update(upload, { status: UploadStatus.Failed });
        this.error.set(true);
      }
    }
  }
  private update(upload: Upload, patch: Partial<Upload>) {
    Object.assign(upload, patch);
    this.uploads.update((items) => [...items]);
  }
  protected remove(upload: Upload) {
    upload.controller.abort();
    URL.revokeObjectURL(upload.url);
    this.uploads.update((items) => items.filter((item) => item !== upload));
  }
  protected removeExisting(id: SnowflakeID) {
    this.existing.update((items) => items.filter((item) => item.id !== id));
  }
  protected async changed(text: string) {
    this.text.set(wireText(editText(this.display(), text)));
    const input = await this.textarea()?.getInputElement();
    const end = input?.selectionStart ?? text.length;
    const match = text.slice(0, end).match(/(?:^|\s)@([^\s@\[\]]*)$/);
    const version = ++this.mentionVersion;
    if (!match) {
      this.suggestions.set([]);
      return;
    }
    this.mentionRange = { start: end - match[1].length - 1, end };
    try {
      const result = await firstValueFrom(
        this.members.getMembers(this.chatId(), { q: match[1], mode: UserSearchMode.autocomplete, limit: 8 }),
      );
      if (version === this.mentionVersion) this.suggestions.set(result.members);
    } catch {
      if (version === this.mentionVersion) this.suggestions.set([]);
    }
  }
  protected async mention(member: MemberResponse) {
    const range = this.mentionRange;
    if (!range) return;
    const name = member.username || 'User ' + member.uid;
    const token = '@' + name + ' ';
    const old = this.display();
    const display = editText(old, old.text.slice(0, range.start) + token + old.text.slice(range.end));
    display.mentions.push({ uid: member.uid, start: range.start, end: range.start + token.length - 1 });
    display.mentions.sort((a, b) => a.start - b.start);
    this.mentionNames.update((names) => new Map(names).set(member.uid, name));
    this.text.set(wireText(display));
    this.suggestions.set([]);
    this.mentionVersion++;
    await this.setFocus();
    const input = await this.textarea()?.getInputElement();
    input?.setSelectionRange(range.start + token.length, range.start + token.length);
  }

  complete(ids: readonly SnowflakeID[]) {
    for (const upload of [...this.uploads()])
      if (upload.id && ids.includes(upload.id)) {
        if (upload.purpose === AttachmentUploadPurpose.voice) this.voice()?.reset();
        this.remove(upload);
      }
    this.existing.update((items) => items.filter((item) => !ids.includes(item.id)));
  }
  protected submit() {
    if (!this.canSend()) return;
    const uploads = this.uploads();
    const files = uploads.filter((u) => u.purpose === AttachmentUploadPurpose.file);
    const voice = uploads.find((u) => u.purpose === AttachmentUploadPurpose.voice);
    if (files.length) this.submitted.emit({ messageType: MessageType.file, attachmentIds: files.map((u) => u.id!) });
    else if (voice) this.submitted.emit({ messageType: MessageType.audio, attachmentIds: [voice.id!] });
    else
      this.submitted.emit({
        messageType: MessageType.text,
        attachmentIds: [...this.existing().map((a) => a.id), ...uploads.map((u) => u.id!)],
      });
  }
  protected sticker(sticker: StickerSummary) {
    if (this.disabled()) return;
    this.panel.set(Panel.None);
    this.submitted.emit({ messageType: MessageType.sticker, attachmentIds: [], sticker });
  }
  protected async sendVoice(file: File) {
    if (this.disabled() || this.pendingUpload()) return;
    let upload = this.uploads().find((u) => u.purpose === AttachmentUploadPurpose.voice);
    if (upload) {
      if (upload.status === UploadStatus.Failed) await this.retryUpload(upload);
    } else upload = await this.addFile(file, AttachmentUploadPurpose.voice);
    if (upload?.status === UploadStatus.Ready && !upload.controller.signal.aborted)
      this.submitted.emit({ messageType: MessageType.audio, attachmentIds: [upload.id!] });
  }
  protected discardVoice() {
    for (const upload of this.uploads()) if (upload.purpose === AttachmentUploadPurpose.voice) this.remove(upload);
    this.error.set(false);
  }
  protected key(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.matchMedia('(hover: hover)').matches) {
      event.preventDefault();
      this.submit();
    }
  }
}
