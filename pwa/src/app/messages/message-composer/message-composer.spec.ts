import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { getPlatforms } from '@ionic/angular';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { vi } from 'vitest';
import { AttachmentsService } from '../../../generated/endpoints/attachments/attachments.service';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import {
  AttachmentUploadPurpose,
  GroupRole,
  MessageType,
  type AttachmentResponse,
  type MentionInfo,
  type SnowflakeID,
  type StickerSummary,
} from '../../../generated/models';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { testChat, testMessage } from '../../api/testing';
import type { MessageContent } from '../message/message';
import { AttachmentUpload, UploadStatus } from '../upload';
import { VoiceRecorder } from '../voice-recorder/voice-recorder';
import { MessageComposer, type Composition } from './message-composer';

class FakeUpload {
  static requests: FakeUpload[] = [];
  status = 200;
  upload = {
    onprogress: undefined as
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | undefined,
  };
  onload?: () => void;
  onabort?: () => void;
  onloadend?: () => void;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => {
    this.onabort?.();
    this.onloadend?.();
  });
  constructor() {
    FakeUpload.requests.push(this);
  }
  finish(status = 200) {
    this.status = status;
    this.onload?.();
    this.onloadend?.();
  }
}

describe('Message composer upload ownership', () => {
  let fixture: ComponentFixture<MessageComposer>;
  let composer: MessageComposer;
  let http: HttpTestingController;
  let queueUploads: AttachmentUpload[];
  let submitted: ReturnType<typeof vi.fn<(composition: Composition) => void>>;
  const existing: AttachmentResponse = {
    id: encodeId('90'),
    fileName: 'existing.gif',
    kind: 'image/gif',
    size: 5,
    url: 'https://media.invalid/existing',
  };

  const pendingMessage: MessageContent = {
    sender: testMessage.sender,
    createdAt: testMessage.createdAt,
    messageType: MessageType.text,
    message: '待发消息',
    attachments: [],
  };

  beforeEach(() => {
    queueUploads = [];
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    http = TestBed.inject(HttpTestingController);
    FakeUpload.requests = [];
    vi.stubGlobal('XMLHttpRequest', FakeUpload);
    vi.stubGlobal('File', NodeFile);
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        naturalWidth = 640;
        naturalHeight = 480;
        decode = vi.fn().mockResolvedValue(undefined);
      },
    );
    let nextUrl = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:mock-${++nextUrl}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    fixture = TestBed.createComponent(MessageComposer);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    composer = fixture.componentInstance;
    submitted = vi.fn();
    composer.submitted.subscribe(submitted);
  });
  afterEach(() => {
    fixture.destroy();
    for (const upload of queueUploads) upload.dispose();
    for (const [composition] of submitted.mock.calls) for (const upload of composition.uploads ?? []) upload.dispose();
    http.verify({ ignoreCancelled: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function add(purpose = AttachmentUploadPurpose.file) {
    const file =
      purpose === AttachmentUploadPurpose.media
        ? new File(['photo'], 'photo.gif', { type: 'image/gif' })
        : new File(['hello'], 'note.txt', { type: 'text/plain' });
    return composer['addFile'](file, purpose)!;
  }
  function edit(message: MessageContent = testMessage, uploads: readonly AttachmentUpload[] = []) {
    fixture.componentRef.setInput('editing', message);
    fixture.componentRef.setInput('editingUploads', uploads);
    fixture.detectChanges();
  }
  function queuedUpload(name = 'queued.gif') {
    const upload = new AttachmentUpload(
      TestBed.inject(AttachmentsService),
      new File(['queued'], name, { type: 'image/gif' }),
      AttachmentUploadPurpose.media,
    );
    queueUploads.push(upload);
    return upload;
  }
  async function startStorage(id: SnowflakeID = encodeId('100')) {
    const index = FakeUpload.requests.length;
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    await vi.waitFor(() =>
      http.expectOne('/_api/attachments/upload-url').flush({
        attachmentId: id,
        uploadHeaders: {},
        uploadUrl: 'https://storage.invalid/upload',
      }),
    );
    await vi.waitFor(() => expect(FakeUpload.requests).toHaveLength(index + 1));
    return FakeUpload.requests[index];
  }

  it('emits an unfinished file synchronously and detaches it before a receiver resets the composer', async () => {
    const upload = add();
    const pending = upload.retry();
    composer.text.set('单独发送的说明');
    composer.submitted.subscribe(() => {
      expect(composer['uploads']()).toEqual([]);
      composer.reset();
    });
    expect(composer['canSend']()).toBe(true);
    composer['submit']();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.file,
      attachmentIds: [],
      uploads: [upload],
    });
    const config = http.expectOne('/_api/attachments/config');
    expect(config.cancelled).toBe(false);
    config.flush({ maxFileSizeBytes: 1024 });
    await vi.waitFor(() =>
      http.expectOne('/_api/attachments/upload-url').flush({
        attachmentId: encodeId('100'),
        uploadHeaders: {},
        uploadUrl: 'https://storage.invalid/upload',
      }),
    );
    await vi.waitFor(() => expect(FakeUpload.requests).toHaveLength(1));
    const xhr = FakeUpload.requests[0];
    composer.reset();
    fixture.destroy();
    expect(xhr.abort).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(upload.url);
    xhr.finish();
    await expect(pending).resolves.toBe(encodeId('100'));
    await expect(upload.retry()).resolves.toBe(encodeId('100'));
    expect(FakeUpload.requests).toHaveLength(1);
    expect(composer.text()).toBe('单独发送的说明');
  });

  it('allows pure media submission while it is still processing', () => {
    const upload = add(AttachmentUploadPurpose.media);
    expect(upload.state().status).toBe(UploadStatus.Processing);
    expect(composer['canSend']()).toBe(true);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: [],
      uploads: [upload],
      mentions: [],
    });
    expect(composer['uploads']()).toEqual([]);
    const config = http.expectOne('/_api/attachments/config');
    expect(config.cancelled).toBe(false);
  });

  it('renders progress from the task signal and permits sending during storage upload', async () => {
    const upload = add();
    const xhr = await startStorage();
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 4 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.uploads').textContent).toContain('75%');
    composer['submit']();
    expect(submitted.mock.calls[0][0].uploads).toEqual([upload]);
    composer.reset();
    expect(xhr.abort).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(upload.url);
  });

  it('hands off failed uploads so retry can continue outside the composer', async () => {
    const upload = add();
    const pending = upload.retry();
    (await startStorage()).finish(403);
    await pending;
    expect(upload.state().status).toBe(UploadStatus.Failed);
    expect(composer['canSend']()).toBe(true);
    composer['submit']();
    expect(submitted.mock.calls[0][0].uploads).toEqual([upload]);
    composer.reset();
    const retry = upload.retry();
    (await startStorage(encodeId('101'))).finish();
    await expect(retry).resolves.toBe(encodeId('101'));
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(upload.url);
  });

  it('sends files first and retains media, voice and draft text for later submissions', () => {
    const media = add(AttachmentUploadPurpose.media);
    const voice = add(AttachmentUploadPurpose.voice);
    const first = add();
    const second = add();
    composer.text.set('给照片的说明');
    composer['submit']();
    expect(submitted.mock.calls[0][0]).toEqual({
      messageType: MessageType.file,
      attachmentIds: [],
      uploads: [first, second],
    });
    expect(composer['uploads']()).toEqual([media, voice]);
    expect(composer.text()).toBe('给照片的说明');
    composer['submit']();
    expect(submitted.mock.calls[1][0]).toEqual({
      messageType: MessageType.audio,
      attachmentIds: [],
      uploads: [voice],
    });
    expect(composer['uploads']()).toEqual([media]);
    expect(composer.text()).toBe('给照片的说明');
    composer['submit']();
    expect(submitted.mock.calls[2][0]).toEqual({
      messageType: MessageType.text,
      attachmentIds: [],
      uploads: [media],
      mentions: [],
    });
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('sends stickers independently while preserving selected attachments and draft text', () => {
    const upload = add();
    composer.text.set('保留草稿');
    const sticker: StickerSummary = {
      id: encodeId('200'),
      createdAt: testMessage.createdAt,
      emoji: '🙂',
      isFavorited: false,
      media: { id: encodeId('201'), contentType: 'image/webp', size: 20, url: 'https://media.invalid/sticker' },
    };
    composer['sticker'](sticker);
    expect(submitted).toHaveBeenCalledExactlyOnceWith({ messageType: MessageType.sticker, attachmentIds: [], sticker });
    expect(composer['uploads']()).toEqual([upload]);
    expect(composer.text()).toBe('保留草稿');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(upload.url);
  });

  it('hands off voice immediately and resets the recorder UI without disposing its upload', () => {
    const recorder = fixture.debugElement.query(By.directive(VoiceRecorder)).componentInstance as VoiceRecorder;
    recorder.active.set(true);
    const reset = vi.spyOn(recorder, 'reset');
    const file = new File(['voice'], 'voice.m4a', { type: 'audio/mp4' });
    recorder.submitted.emit(file);
    expect(submitted).toHaveBeenCalledOnce();
    const composition = submitted.mock.calls[0][0];
    const upload = composition.uploads![0];
    expect(upload).toBeInstanceOf(AttachmentUpload);
    expect(upload.file).toBe(file);
    expect(upload.purpose).toBe(AttachmentUploadPurpose.voice);
    expect(composition).toEqual({ messageType: MessageType.audio, attachmentIds: [], uploads: [upload] });
    expect(upload.state().status).toBe(UploadStatus.Uploading);
    expect(reset).toHaveBeenCalledOnce();
    expect(composer.voiceActive()).toBe(false);
    expect(composer['uploads']()).toEqual([]);
    composer.reset();
    fixture.destroy();
    expect(http.expectOne('/_api/attachments/config').cancelled).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(upload.url);
  });

  it('sends a voice task even if another selected attachment is still processing', () => {
    const media = add(AttachmentUploadPurpose.media);
    composer.text.set('保留文字');
    const file = new File(['voice'], 'voice.m4a', { type: 'audio/mp4' });
    composer['sendVoice'](file);
    const composition = submitted.mock.calls[0][0];
    expect(composition.messageType).toBe(MessageType.audio);
    expect(composition.uploads?.[0].file).toBe(file);
    expect(composer['uploads']()).toEqual([media]);
    expect(composer.text()).toBe('保留文字');
  });

  it.each(['processing', 'uploading', 'failed', 'ready'] as const)(
    'hands off %s edit uploads before the receiver immediately exits editing',
    async (phase) => {
      const removed = { ...existing, id: encodeId('91'), fileName: 'removed.gif' };
      const mentions = [{ uid: 42, gender: 1, username: '原消息名字' }];
      edit({ ...testMessage, attachments: [existing, removed], mentions });
      composer['removeExisting'](removed.id);
      composer.text.set('@[uid:42] 修改后的说明');
      const upload = add(AttachmentUploadPurpose.media);
      const dispose = vi.spyOn(upload, 'dispose');
      const pending = upload.retry();
      expect(upload.state().status).toBe(UploadStatus.Processing);
      let xhr: FakeUpload | undefined;
      if (phase !== 'processing') {
        xhr = await startStorage();
        expect(upload.state().status).toBe(UploadStatus.Uploading);
        if (phase !== 'uploading') {
          xhr.finish(phase === 'failed' ? 403 : 200);
          await pending;
          expect(upload.state().status).toBe(phase === 'failed' ? UploadStatus.Failed : UploadStatus.Ready);
        }
      }
      composer.submitted.subscribe(() => {
        expect(composer['uploads']()).toEqual([]);
        fixture.componentRef.setInput('editing', undefined);
        fixture.detectChanges();
        expect(composer['existing']()).toEqual([]);
      });
      expect(composer['canSend']()).toBe(true);
      fixture.detectChanges();
      const button = fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.querySelector('ion-spinner')).toBeNull();
      button.click();
      expect(submitted).toHaveBeenCalledExactlyOnceWith({
        messageType: MessageType.text,
        attachmentIds: [existing.id],
        uploads: [upload],
        mentions,
      });
      composer.reset();
      fixture.destroy();
      expect(dispose).not.toHaveBeenCalled();
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(upload.url);
      if (xhr) expect(xhr.abort).not.toHaveBeenCalled();
      const continuation = upload.retry();
      if (phase === 'processing' || phase === 'failed') xhr = await startStorage();
      if (phase !== 'ready') xhr!.finish();
      await expect(continuation).resolves.toBe(encodeId('100'));
      expect(dispose).not.toHaveBeenCalled();
      expect(composer.text()).toBe('@[uid:42] 修改后的说明');
    },
  );

  it('saves existing attachment ids without requiring text or new uploads', () => {
    edit({ ...testMessage, attachments: [existing] });
    composer.text.set('  ');
    expect(composer['canSend']()).toBe(true);
    composer['submit']();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: [existing.id],
      uploads: [],
      mentions: [],
    });
    http.expectNone('/_api/attachments/config');
  });

  it('allows an edit containing only unfinished new media', () => {
    edit();
    composer.text.set('  ');
    const upload = add(AttachmentUploadPurpose.media);
    expect(upload.state().status).toBe(UploadStatus.Processing);
    expect(composer['canSend']()).toBe(true);
    composer['submit']();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: [],
      uploads: [upload],
      mentions: [],
    });
    expect(composer['uploads']()).toEqual([]);
    expect(http.expectOne('/_api/attachments/config').cancelled).toBe(false);
  });

  it('only cancels the current draft when an earlier edit has handed off its upload', async () => {
    edit();
    const sent = add(AttachmentUploadPurpose.media);
    const sentRequest = await startStorage();
    composer['submit']();
    fixture.componentRef.setInput('editing', undefined);
    fixture.detectChanges();
    const retained = add(AttachmentUploadPurpose.media);
    const retainedRequest = http.expectOne('/_api/attachments/config');
    composer.reset();
    expect(retainedRequest.cancelled).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(retained.url);
    expect(sentRequest.abort).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(sent.url);
  });

  it('edits a message without an id and hands off borrowed and new tasks before immediately exiting', async () => {
    const borrowed = queuedUpload();
    const borrowedPending = borrowed.retry();
    const borrowedRequest = await startStorage();
    const selection = Object.freeze([borrowed]);
    edit(
      {
        ...pendingMessage,
        attachments: [
          existing,
          { url: borrowed.url, kind: borrowed.file.type, fileName: borrowed.file.name, size: borrowed.file.size },
        ],
      },
      selection,
    );
    const owned = add(AttachmentUploadPurpose.media);
    const ownedPending = owned.retry();
    const dispose = vi.spyOn(owned, 'dispose');
    borrowedRequest.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
    fixture.detectChanges();
    expect(composer.editing()?.id).toBeUndefined();
    expect(composer['existing']()).toEqual([existing]);
    expect(composer['visualUploads']()).toEqual([borrowed, owned]);
    expect(fixture.nativeElement.querySelectorAll('.upload')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('.uploads').textContent).toContain('25%');
    composer.submitted.subscribe(() => {
      expect(composer['uploads']()).toEqual([]);
      expect(composer['borrowedUploads']()).toEqual([]);
      fixture.componentRef.setInput('editing', undefined);
      fixture.componentRef.setInput('editingUploads', []);
      fixture.detectChanges();
      composer.reset();
      fixture.destroy();
    });
    expect(composer['canSend']()).toBe(true);
    (fixture.nativeElement.querySelector('.send-button') as HTMLButtonElement).click();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: [existing.id],
      uploads: [borrowed, owned],
      mentions: [],
    });
    expect(selection).toEqual([borrowed]);
    expect(dispose).not.toHaveBeenCalled();
    expect(borrowedRequest.abort).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(borrowed.url);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(owned.url);
    borrowedRequest.finish();
    await expect(borrowedPending).resolves.toBe(encodeId('100'));
    (await startStorage(encodeId('101'))).finish();
    await expect(ownedPending).resolves.toBe(encodeId('101'));
  });

  it('deselects failed borrowed tasks without disposal and restores them when editing is reopened', async () => {
    const borrowed = queuedUpload();
    const pending = borrowed.retry();
    const request = await startStorage();
    request.finish(403);
    await pending;
    const dispose = vi.spyOn(borrowed, 'dispose');
    const selection = Object.freeze([borrowed]);
    edit(pendingMessage, selection);
    expect(composer['error']()).toBe(true);
    expect(composer['canSend']()).toBe(true);
    const owned = add(AttachmentUploadPurpose.media);
    const ownedRequest = http.expectOne('/_api/attachments/config');
    composer['remove'](borrowed);
    expect(composer['visualUploads']()).toEqual([owned]);
    expect(composer['error']()).toBe(false);
    expect(selection).toEqual([borrowed]);
    composer['remove'](owned);
    expect(ownedRequest.cancelled).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(owned.url);
    expect(composer['canSend']()).toBe(false);
    composer['submit']();
    expect(submitted).not.toHaveBeenCalled();
    fixture.componentRef.setInput('editing', undefined);
    fixture.detectChanges();
    edit(pendingMessage, selection);
    expect(composer['visualUploads']()).toEqual([borrowed]);
    expect(dispose).not.toHaveBeenCalled();
    expect(request.abort).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(borrowed.url);
    const retry = borrowed.retry();
    (await startStorage(encodeId('101'))).finish();
    await expect(retry).resolves.toBe(encodeId('101'));
  });

  it.each(['cancel', 'reset', 'destroy'] as const)('only disposes newly created edit tasks on %s', async (action) => {
    const borrowed = queuedUpload();
    const pending = borrowed.retry();
    const borrowedRequest = await startStorage();
    edit(pendingMessage, [borrowed]);
    const owned = add(AttachmentUploadPurpose.media);
    const ownedRequest = await startStorage(encodeId('101'));
    if (action === 'cancel') {
      fixture.componentRef.setInput('editing', undefined);
      fixture.componentRef.setInput('editingUploads', []);
      fixture.detectChanges();
    } else if (action === 'reset') composer.reset();
    else fixture.destroy();
    expect(composer['selectedUploads']()).toEqual([]);
    expect(ownedRequest.abort).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(owned.url);
    expect(borrowedRequest.abort).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(borrowed.url);
    borrowedRequest.finish();
    await expect(pending).resolves.toBe(encodeId('100'));
  });

  it('replaces borrowed selection when the queue input changes while retaining newly created tasks', () => {
    const first = queuedUpload();
    edit(pendingMessage, [first]);
    const owned = add(AttachmentUploadPurpose.media);
    const next = queuedUpload('next.gif');
    fixture.componentRef.setInput('editingUploads', Object.freeze([next]));
    fixture.detectChanges();
    expect(composer['visualUploads']()).toEqual([next, owned]);
    expect(composer['uploads']()).toEqual([owned]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    composer['submit']();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: [],
      uploads: [next, owned],
      mentions: [],
    });
  });

  it('counts borrowed tasks toward the attachment limit and leaves deselected tasks to the queue on save', () => {
    const borrowed = queuedUpload();
    const request = http.expectOne('/_api/attachments/config');
    const attachments = Array.from({ length: 19 }, (_, index) => ({ ...existing, id: encodeId(String(index + 1)) }));
    edit({ ...pendingMessage, attachments }, [borrowed]);
    expect(add(AttachmentUploadPurpose.media)).toBeUndefined();
    expect(composer['tooMany']()).toBe(true);
    http.expectNone('/_api/attachments/config');
    composer['remove'](borrowed);
    const owned = add(AttachmentUploadPurpose.media);
    expect(owned).toBeInstanceOf(AttachmentUpload);
    composer['submit']();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: attachments.map((attachment) => attachment.id),
      uploads: [owned],
      mentions: [],
    });
    composer.reset();
    fixture.destroy();
    expect(request.cancelled).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(borrowed.url);
    expect(http.expectOne('/_api/attachments/config').cancelled).toBe(false);
  });

  it.each(['reset', 'destroy'] as const)('only cancels tasks still owned by the composer on %s', async (action) => {
    const sent = add();
    const sentRequest = await startStorage();
    const retained = add(AttachmentUploadPurpose.media);
    const retainedRequest = http.expectOne('/_api/attachments/config');
    composer['submit']();
    expect(composer['uploads']()).toEqual([retained]);
    if (action === 'reset') composer.reset();
    else fixture.destroy();
    expect(retainedRequest.cancelled).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(retained.url);
    expect(sentRequest.abort).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(sent.url);
  });

  it('captures only the current mentions with their displayed names and member information', async () => {
    const member = {
      uid: 42,
      gender: 1,
      username: '当前昵称很长',
      role: GroupRole.member,
      joinedAt: testMessage.createdAt,
    };
    const input = await composer['textarea']()!.getInputElement();
    input.value = '@当';
    input.setSelectionRange(2, 2);
    const changed = composer['changed']('@当');
    await vi.waitFor(() =>
      http
        .expectOne((request) => request.url === `/_api/group/${decodeId(testChat.id)}/members`)
        .flush({ members: [member] }),
    );
    await changed;
    await composer['mention'](member);
    composer.text.set(composer.text() + '@[uid:42] @[uid:99]');
    composer['submit']();
    const mentions = submitted.mock.calls[0][0].mentions;
    expect(mentions).toEqual([
      { uid: 42, gender: 1, username: member.username, avatarUrl: undefined, userGroup: undefined },
      { uid: 99, gender: 0, username: 'User 99' },
    ] satisfies MentionInfo[]);
    composer.text.set('不再包含提及');
    composer['submit']();
    expect(submitted.mock.calls[1][0].mentions).toEqual([]);
    expect(mentions?.[0].username).toBe('当前昵称很长');
  });

  it('retains editing mention names in the emitted snapshot', () => {
    const mentions = [{ uid: 42, gender: 1, username: '原消息名字' }];
    edit({ ...testMessage, mentions });
    composer.text.set('@[uid:42]');
    composer['submit']();
    expect(submitted.mock.calls[0][0].mentions).toEqual(mentions);
  });

  it.each([false, true])('rejects empty or whitespace-only content when editing is %s', (editing) => {
    if (editing) {
      edit({ ...testMessage, attachments: [existing] });
      composer['removeExisting'](existing.id);
    }
    for (const text of ['', '  \n ']) {
      composer.text.set(text);
      expect(composer['canSend']()).toBe(false);
      composer['submit']();
    }
    expect(submitted).not.toHaveBeenCalled();
  });

  it('keeps text submission and attachment selection blocked during recording', () => {
    const recorder = fixture.debugElement.query(By.directive(VoiceRecorder)).componentInstance as VoiceRecorder;
    recorder.active.set(true);
    fixture.detectChanges();
    expect(composer.voiceActive()).toBe(true);
    expect(fixture.nativeElement.querySelector('.attach-button').disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.input-wrapper').hidden).toBe(true);
    composer.text.set('录音中的文字');
    expect(composer['canSend']()).toBe(false);
    composer['submit']();
    expect(submitted).not.toHaveBeenCalled();
    composer.voiceActive.set(false);
    composer['submit']();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: [],
      uploads: [],
      mentions: [],
    });
  });

  it('preserves image/video-only editing and hides voice and sticker controls', () => {
    edit();
    expect(composer['addFile'](new File(['file'], 'note.txt'), AttachmentUploadPurpose.file)).toBeUndefined();
    expect(composer['addFile'](new File(['voice'], 'voice.m4a'), AttachmentUploadPurpose.voice)).toBeUndefined();
    expect(composer['unsupported']()).toBe(true);
    composer['sendVoice'](new File(['voice'], 'voice.m4a'));
    expect(composer['useVoice']()).toBe(false);
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(VoiceRecorder))).toBeNull();
    expect(fixture.nativeElement.querySelector('.sticker-button')).toBeNull();
    expect(submitted).not.toHaveBeenCalled();
    http.expectNone('/_api/attachments/config');
    composer.text.set('修改');
    composer['submit']();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: [],
      uploads: [],
      mentions: [],
    });
  });
  it('keeps text and attachment ownership when a blocked DM cannot send', () => {
    fixture.componentRef.setInput('relationship', { canDm: false, blocking: true });
    composer.text.set('稍后发送');
    composer['existing'].set([existing]);
    fixture.detectChanges();
    composer['submit']();
    expect(submitted).not.toHaveBeenCalled();
    expect(composer.text()).toBe('稍后发送');
    expect(composer['existing']()).toEqual([existing]);
    expect(composer['blocked']()).toBe(true);
    expect(composer['canSend']()).toBe(true);
    fixture.componentRef.setInput('relationship', { canDm: true });
    fixture.detectChanges();
    composer['submit']();
    expect(submitted).toHaveBeenCalledOnce();
  });
  it('selects mention candidates before Enter can send and leaves IME composition alone', async () => {
    const first = { uid: 2, username: '甲', gender: 0, role: GroupRole.member, joinedAt: '' };
    const second = { ...first, uid: 3, username: '乙' };
    composer['suggestions'].set([first, second]);
    const mention = vi
      .spyOn(composer as unknown as { mention: (user: typeof first) => Promise<void> }, 'mention')
      .mockResolvedValue();
    composer['key'](new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    composer['key'](new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(mention).not.toHaveBeenCalled();
    composer['key'](new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(mention).toHaveBeenCalledWith(second);
    expect(submitted).not.toHaveBeenCalled();
    composer['key'](new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(composer['suggestions']()).toEqual([]);
  });
});

describe('Message composer keyboard', () => {
  it.each([
    ['desktop', ['desktop'], true],
    ['iOS', ['ios', 'mobile'], false],
    ['iPadOS', ['ios', 'ipad'], false],
    ['Android', ['android', 'mobile'], false],
  ] as const)('uses the operating system on %s even when hover capability changes', (_name, system, sends) => {
    const platforms = getPlatforms();
    const original = [...platforms];
    platforms.splice(0, platforms.length, ...system);
    const fixture = TestBed.createComponent(MessageComposer);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const composer = fixture.componentInstance;
    const submit = vi.spyOn(composer as unknown as { submit(): void }, 'submit').mockImplementation(() => {});
    try {
      for (const hover of [false, true]) {
        vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: hover }));
        const key = (options: KeyboardEventInit = {}) => {
          const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...options });
          composer['key'](event);
          return event.defaultPrevented;
        };
        expect(key({ shiftKey: true })).toBe(false);
        expect(key({ isComposing: true })).toBe(false);
        expect(key({ keyCode: 229 })).toBe(false);
        expect(key()).toBe(sends);
      }
      expect(submit).toHaveBeenCalledTimes(sends ? 2 : 0);
    } finally {
      fixture.destroy();
      platforms.splice(0, platforms.length, ...original);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
