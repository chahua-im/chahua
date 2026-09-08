import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import {
  AttachmentUploadPurpose,
  GroupRole,
  MessageType,
  type AttachmentResponse,
  type MentionInfo,
  type MessageResponse,
  type SnowflakeID,
  type StickerSummary,
} from '../../../generated/models';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { testChat, testMessage } from '../../api/testing';
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
  let submitted: ReturnType<typeof vi.fn<(composition: Composition) => void>>;

  beforeEach(() => {
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
  function edit(message: MessageResponse = testMessage) {
    fixture.componentRef.setInput('editing', message);
    fixture.detectChanges();
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

  it('keeps editing blocked until attachments are ready and only clears completed edit attachments', async () => {
    const existing: AttachmentResponse = {
      id: encodeId('90'),
      fileName: 'existing.gif',
      kind: 'image/gif',
      size: 5,
      url: 'https://media.invalid/existing',
    };
    edit({ ...testMessage, attachments: [existing] });
    composer.text.set('修改后的说明');
    const upload = add(AttachmentUploadPurpose.media);
    const pending = upload.retry();
    expect(composer['canSend']()).toBe(false);
    composer['submit']();
    expect(submitted).not.toHaveBeenCalled();
    const xhr = await startStorage();
    expect(composer['canSend']()).toBe(false);
    composer['submit']();
    expect(submitted).not.toHaveBeenCalled();
    xhr.finish(403);
    await pending;
    expect(composer['canSend']()).toBe(false);
    composer['submit']();
    expect(submitted).not.toHaveBeenCalled();
    const retry = upload.retry();
    (await startStorage(encodeId('101'))).finish();
    await retry;
    expect(composer['canSend']()).toBe(true);
    composer['submit']();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      messageType: MessageType.text,
      attachmentIds: [existing.id, encodeId('101')],
      mentions: [],
    });
    expect(composer['uploads']()).toEqual([upload]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(upload.url);
    const next = add(AttachmentUploadPurpose.media);
    composer.complete([existing.id, encodeId('101')]);
    expect(composer['uploads']()).toEqual([next]);
    expect(composer['existing']()).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(upload.url);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(next.url);
    expect(composer.text()).toBe('修改后的说明');
  });

  it('does not let completion of a sent message clear current non-editing attachments', async () => {
    const upload = add();
    const pending = upload.retry();
    (await startStorage()).finish();
    await pending;
    composer.complete([encodeId('100')]);
    expect(composer['uploads']()).toEqual([upload]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(upload.url);
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

  it('preserves edit restrictions and explicit disabled state', () => {
    edit();
    expect(composer['addFile'](new File(['file'], 'note.txt'), AttachmentUploadPurpose.file)).toBeUndefined();
    expect(composer['unsupported']()).toBe(true);
    http.expectNone('/_api/attachments/config');
    composer.text.set('修改');
    fixture.componentRef.setInput('disabled', true);
    expect(composer['canSend']()).toBe(false);
    composer['submit']();
    composer['sendVoice'](new File(['voice'], 'voice.m4a'));
    expect(submitted).not.toHaveBeenCalled();
  });
});
