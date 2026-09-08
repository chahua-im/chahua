import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { AttachmentUploadPurpose, MessageType } from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { testChat } from '../../api/testing';
import { MessageComposer } from './message-composer';
describe('Message composer resources', () => {
  let xhr: FakeUpload;
  class FakeUpload {
    status = 200;
    upload = {};
    onload?: () => void;
    onloadend?: () => void;
    open() {}
    setRequestHeader() {}
    send() {}
    abort() {}
    constructor() {
      xhr = this;
    }
  }
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    vi.stubGlobal('XMLHttpRequest', FakeUpload);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('uploads a file before submitting its ID and keeps separate draft text', async () => {
    const fixture = TestBed.createComponent(MessageComposer);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const composer = fixture.componentInstance;
    composer.text.set('单独发送的说明');
    const chosen = vi.fn();
    composer.submitted.subscribe(chosen);
    const upload = composer['addFile'](
      new File(['hello'], 'note.txt', { type: 'text/plain' }),
      AttachmentUploadPurpose.file,
    );
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    await vi.waitFor(() =>
      expect(
        http
          .match((req) => req.url === '/_api/attachments/upload-url')
          .map((request) => {
            expect(request.request.body.purpose).toBe('file');
            request.flush({
              attachmentId: encodeId('100'),
              uploadHeaders: {},
              uploadUrl: 'https://storage.invalid/upload',
            });
            return true;
          }),
      ).toEqual([true]),
    );
    await vi.waitFor(() => expect(xhr).toBeDefined());
    xhr.onload?.();
    xhr.onloadend?.();
    await upload;
    composer['submit']();
    expect(chosen).toHaveBeenCalledWith({ messageType: MessageType.file, attachmentIds: [encodeId('100')] });
    composer.complete([encodeId('100')]);
    expect(composer.text()).toBe('单独发送的说明');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});
