import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  linkedSignal,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { IonAlert, IonButton, IonIcon, IonItem, IonLabel, IonList, IonTextarea, isPlatform } from '@ionic/angular';
import {
  addCircleOutline,
  closeOutline,
  documentOutline,
  happyOutline,
  imageOutline,
  send,
  videocamOutline,
} from 'ionicons/icons';
import { firstValueFrom } from 'rxjs';
import { AttachmentsService } from '../../../generated/endpoints/attachments/attachments.service';
import { MembersService } from '../../../generated/endpoints/members/members.service';
import type { FriendRelationshipResponse } from '../../../generated/models';
import {
  AttachmentUploadPurpose,
  MessageType,
  UserSearchMode,
  type AttachmentResponse,
  type MemberResponse,
  type MentionInfo,
  type SnowflakeID,
  type StickerSummary,
} from '../../../generated/models';
import { mayBeMediaFile } from '../media-processing/file-type';
import type { MessageContent } from '../message/message';
import { StickerPicker } from '../sticker-picker/sticker-picker';
import { AttachmentUpload, UploadStatus } from '../upload';
import { UploadProgress } from '../upload-progress/upload-progress';
import { VoicePlayer } from '../voice-player/voice-player';
import { VoiceRecorder } from '../voice-recorder/voice-recorder';
import { displayText, editText, wireText } from './mention-text';
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
  imports: [
    NgTemplateOutlet,
    IonAlert,
    VoicePlayer,
    IonButton,
    IonIcon,
    IonTextarea,
    UploadProgress,
    IonList,
    IonItem,
    IonLabel,
    StickerPicker,
    VoiceRecorder,
  ],
  host: {
    '(document:click)': 'outside($event)',
    '[class.drag-over]': 'dragDepth() > 0',
    '(dragenter)': 'dragenter($event)',
    '(dragover)': 'dragover($event)',
    '(dragleave)': 'dragleave()',
    '(drop)': 'drop($event)',
    '(document:dragend)': 'dragDepth.set(0)',
  },
})
export class MessageComposer {
  readonly text = model('');
  readonly relationship = input<FriendRelationshipResponse>();
  protected readonly blocked = signal(false);
  private canWrite() {
    const allowed = this.relationship()?.canDm !== false;
    this.blocked.set(!allowed);
    return allowed;
  }
  readonly chatId = input.required<SnowflakeID>();
  readonly editing = input<MessageContent>();
  readonly editingUploads = input<readonly AttachmentUpload[]>([]);
  readonly submitted = output<Composition>();
  readonly editLast = output<void>();
  readonly escape = output<void>();
  protected readonly icons = {
    addCircleOutline,
    happyOutline,
    send,
    closeOutline,
    imageOutline,
    documentOutline,
    videocamOutline,
  };
  private readonly mobile = isPlatform('ios') || isPlatform('android');
  protected readonly windows = navigator.userAgent.includes('Windows');
  protected readonly macOS = !isPlatform('ios') && navigator.userAgent.includes('Macintosh');
  protected readonly Status = UploadStatus;
  private readonly api = inject(AttachmentsService);
  private readonly members = inject(MembersService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly voice = viewChild(VoiceRecorder);
  protected readonly Panel = Panel;
  protected readonly Purpose = AttachmentUploadPurpose;
  protected readonly panel = signal(Panel.None);
  protected readonly dragDepth = signal(0);
  readonly voiceActive = signal(false);
  private readonly destroy = inject(DestroyRef);
  private readonly textarea = viewChild(IonTextarea);
  protected readonly uploads = signal<AttachmentUpload[]>([]);
  protected readonly borrowedUploads = linkedSignal(() => this.editingUploads());
  protected readonly selectedUploads = computed(() => [...this.borrowedUploads(), ...this.uploads()]);
  protected readonly existing = signal<AttachmentResponse[]>([]);
  protected readonly error = computed(() =>
    this.selectedUploads().some((u) => u.state().status === UploadStatus.Failed),
  );
  protected readonly suggestions = signal<MemberResponse[]>([]);
  protected readonly selectedSuggestion = linkedSignal(() => {
    this.suggestions();
    return 0;
  });
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
  protected readonly canSend = computed(
    () => !this.voiceActive() && (!!this.text().trim() || !!this.existing().length || !!this.selectedUploads().length),
  );
  protected readonly visualUploads = computed(() =>
    this.selectedUploads().filter((u) => u.purpose !== AttachmentUploadPurpose.voice),
  );
  protected readonly useVoice = computed(
    () => !this.editing() && !this.text().trim() && !this.existing().length && !this.selectedUploads().length,
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
        this.existing.set(
          message?.attachments.filter((attachment): attachment is AttachmentResponse => attachment.id != null) ?? [],
        );
        this.borrowedUploads.set(message ? this.editingUploads() : []);
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
    this.borrowedUploads.set([]);
    this.existing.set([]);
    this.voice()?.reset();
    this.panel.set(Panel.None);
    this.dragDepth.set(0);
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

  protected dragenter(event: DragEvent) {
    if (event.dataTransfer?.types.includes('Files')) this.dragDepth.update((depth) => depth + 1);
  }
  dragover(event: DragEvent) {
    const transfer = event.dataTransfer;
    if (!transfer?.types.includes('Files')) return;
    event.preventDefault();
    transfer.dropEffect = 'copy';
  }
  protected dragleave() {
    this.dragDepth.update((depth) => Math.max(0, depth - 1));
  }
  drop(event: DragEvent) {
    this.dragDepth.set(0);
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    for (const file of Array.from(event.dataTransfer?.files ?? []))
      this.addFile(file, mayBeMediaFile(file) ? AttachmentUploadPurpose.media : AttachmentUploadPurpose.file);
  }
  protected paste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files)
      this.addFile(file, mayBeMediaFile(file) ? AttachmentUploadPurpose.media : AttachmentUploadPurpose.file);
  }
  private addFile(file: File, purpose: AttachmentUploadPurpose) {
    if (this.selectedUploads().length + this.existing().length >= 20) {
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
    if (this.uploads().includes(upload)) upload.dispose();
    this.borrowedUploads.update((items) => items.filter((item) => item !== upload));
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
  private handoff(messageType: MessageType, uploads: AttachmentUpload[]) {
    if (!this.canWrite()) return false;
    // Detach before emitting: the receiver may synchronously reset or destroy the composer.
    this.uploads.update((items) => items.filter((item) => !uploads.includes(item)));
    this.borrowedUploads.update((items) => items.filter((item) => !uploads.includes(item)));
    this.submitted.emit({
      messageType,
      attachmentIds: this.existing().map((attachment) => attachment.id),
      uploads,
      ...(messageType === MessageType.text ? { mentions: this.mentionSnapshot() } : {}),
    });
    return true;
  }
  protected submit() {
    if (!this.canSend()) return;
    const uploads = this.selectedUploads();
    if (this.editing()) {
      this.handoff(MessageType.text, uploads);
      return;
    }
    const files = uploads.filter((u) => u.purpose === AttachmentUploadPurpose.file);
    const voice = uploads.find((u) => u.purpose === AttachmentUploadPurpose.voice);
    if (files.length) this.handoff(MessageType.file, files);
    else if (voice) this.handoff(MessageType.audio, [voice]);
    else this.handoff(MessageType.text, uploads);
  }
  protected sticker(sticker: StickerSummary) {
    if (!this.canWrite()) return;
    this.panel.set(Panel.None);
    this.submitted.emit({ messageType: MessageType.sticker, attachmentIds: [], sticker });
  }
  protected sendVoice(file: File) {
    if (this.editing() || !this.canWrite()) return;
    const upload = this.addFile(file, AttachmentUploadPurpose.voice);
    if (!upload) return;
    if (this.handoff(MessageType.audio, [upload]) !== false) this.voice()?.reset();
  }
  protected discardVoice() {
    for (const upload of this.uploads()) if (upload.purpose === AttachmentUploadPurpose.voice) this.remove(upload);
  }
  protected key(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    const suggestions = this.suggestions();
    if (suggestions.length && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter') void this.mention(suggestions[this.selectedSuggestion()]);
      else if (event.key === 'Escape') {
        this.mentionVersion++;
        this.suggestions.set([]);
      } else
        this.selectedSuggestion.update(
          (index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length,
        );
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.escape.emit();
      return;
    }
    if (event.key === 'ArrowUp' && !this.text() && !this.editing() && !this.selectedUploads().length) {
      event.preventDefault();
      this.editLast.emit();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !this.mobile) {
      event.preventDefault();
      this.submit();
    }
  }
}
