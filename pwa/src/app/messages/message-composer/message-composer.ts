import { ElementRef } from '@angular/core';
import { VoiceRecorder } from '../voice-recorder/voice-recorder';
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
  type MentionInfo,
  type MessageResponse,
  type SnowflakeID,
  type StickerSummary,
} from '../../../generated/models';
import { AttachmentUpload, UploadStatus } from '../upload';
import { StickerPicker } from '../sticker-picker/sticker-picker';
export interface Composition {
  messageType: MessageType;
  attachmentIds: SnowflakeID[];
  sticker?: StickerSummary;
  uploads?: AttachmentUpload[];
  mentions?: MentionInfo[];
}
enum Panel {
  None,
  Attachments,
  Stickers,
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
  protected readonly uploads = signal<AttachmentUpload[]>([]);
  protected readonly existing = signal<AttachmentResponse[]>([]);
  protected readonly error = computed(() => this.uploads().some((u) => u.state().status === UploadStatus.Failed));
  protected readonly suggestions = signal<MemberResponse[]>([]);
  protected readonly tooMany = signal(false);
  protected readonly unsupported = signal(false);
  private mentionVersion = 0;
  private mentionRange?: { start: number; end: number };
  private readonly mentionInfos = signal(new Map<number, MentionInfo>());
  protected readonly display = computed(() =>
    displayText(
      this.text(),
      new Map([
        ...[...this.mentionInfos().values()].map((m) => [m.uid, m.username!] as const),
        ...(this.editing()?.mentions ?? []).filter((m) => m.username).map((m) => [m.uid, m.username!] as const),
      ]),
    ),
  );
  protected readonly uploading = computed(() => this.uploads().some((u) => u.state().status !== UploadStatus.Ready));
  protected readonly canSend = computed(
    () =>
      !this.disabled() &&
      (!this.editing() || !this.uploading()) &&
      !this.voiceActive() &&
      (!!this.text().trim() || !!this.existing().length || !!this.uploads().length),
  );
  protected readonly visualUploads = computed(() =>
    this.uploads().filter((u) => u.purpose !== AttachmentUploadPurpose.voice),
  );
  protected readonly useVoice = computed(
    () => !this.editing() && !this.text().trim() && !this.existing().length && !this.uploads().length,
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
    for (const upload of this.uploads()) upload.dispose();
    this.uploads.set([]);
    this.existing.set([]);
    this.voice()?.reset();
    this.panel.set(Panel.None);
    this.mentionVersion++;
    this.mentionRange = undefined;
    this.suggestions.set([]);
    this.tooMany.set(false);
    this.unsupported.set(false);
  }
  protected files(event: Event, purpose: AttachmentUploadPurpose) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.panel.set(Panel.None);
    for (const file of files) this.addFile(file, purpose);
  }

  protected paste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files)
      this.addFile(file, mayBeMediaFile(file) ? AttachmentUploadPurpose.media : AttachmentUploadPurpose.file);
  }
  private addFile(file: File, purpose: AttachmentUploadPurpose) {
    if (this.uploads().length + this.existing().length >= 20) {
      this.tooMany.set(true);
      return;
    }
    if (this.editing() && purpose !== AttachmentUploadPurpose.media) {
      this.unsupported.set(true);
      return;
    }
    const upload = new AttachmentUpload(this.api, file, purpose);
    this.uploads.update((items) => [...items, upload]);
    return upload;
  }
  protected remove(upload: AttachmentUpload) {
    upload.dispose();
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
    const { uid, gender, avatarUrl, userGroup } = member;
    this.mentionInfos.update((mentions) =>
      new Map(mentions).set(uid, { uid, gender, avatarUrl, userGroup, username: name }),
    );
    this.text.set(wireText(display));
    this.suggestions.set([]);
    this.mentionVersion++;
    await this.setFocus();
    const input = await this.textarea()?.getInputElement();
    input?.setSelectionRange(range.start + token.length, range.start + token.length);
  }

  private mentionSnapshot(): MentionInfo[] {
    const display = this.display();
    const known = new Map([
      ...this.mentionInfos(),
      ...(this.editing()?.mentions ?? []).map((m) => [m.uid, m] as const),
    ]);
    return [
      ...new Map(
        display.mentions.map(({ uid, start, end }) => [
          uid,
          {
            ...known.get(uid),
            uid,
            gender: known.get(uid)?.gender ?? 0,
            username: display.text.slice(start + 1, end),
          },
        ]),
      ).values(),
    ];
  }
  complete(ids: readonly SnowflakeID[]) {
    if (!this.editing()) return;
    for (const upload of this.uploads()) {
      const id = upload.state().id;
      if (id != null && ids.includes(id)) this.remove(upload);
    }
    this.existing.update((items) => items.filter((item) => !ids.includes(item.id)));
  }
  private handoff(messageType: MessageType, uploads: AttachmentUpload[]) {
    // Detach before emitting: the receiver may synchronously reset or destroy the composer.
    this.uploads.update((items) => items.filter((item) => !uploads.includes(item)));
    this.submitted.emit({
      messageType,
      attachmentIds: [],
      uploads,
      ...(messageType === MessageType.text ? { mentions: this.mentionSnapshot() } : {}),
    });
  }
  protected submit() {
    if (!this.canSend()) return;
    const uploads = this.uploads();
    if (this.editing()) {
      this.submitted.emit({
        messageType: MessageType.text,
        attachmentIds: [...this.existing().map((a) => a.id), ...uploads.map((u) => u.state().id!)],
        mentions: this.mentionSnapshot(),
      });
      return;
    }
    const files = uploads.filter((u) => u.purpose === AttachmentUploadPurpose.file);
    const voice = uploads.find((u) => u.purpose === AttachmentUploadPurpose.voice);
    if (files.length) this.handoff(MessageType.file, files);
    else if (voice) this.handoff(MessageType.audio, [voice]);
    else this.handoff(MessageType.text, uploads);
  }
  protected sticker(sticker: StickerSummary) {
    if (this.disabled()) return;
    this.panel.set(Panel.None);
    this.submitted.emit({ messageType: MessageType.sticker, attachmentIds: [], sticker });
  }
  protected sendVoice(file: File) {
    if (this.disabled() || this.editing()) return;
    const upload = this.addFile(file, AttachmentUploadPurpose.voice);
    if (!upload) return;
    this.handoff(MessageType.audio, [upload]);
    this.voice()?.reset();
  }
  protected discardVoice() {
    for (const upload of this.uploads()) if (upload.purpose === AttachmentUploadPurpose.voice) this.remove(upload);
  }
  protected key(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.matchMedia('(hover: hover)').matches) {
      event.preventDefault();
      this.submit();
    }
  }
}
