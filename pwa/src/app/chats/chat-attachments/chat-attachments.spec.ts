import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ChatAttachmentKindFilter } from '../../../generated/models';
import { ModalController } from '@ionic/angular';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { jsonInterceptor } from '../../api/json.interceptor';
import { testChat, wireChat, wireMessage } from '../../api/testing';
import { MediaKind } from '../../messages/message-attachments/media-kind';
import { ChatAttachments } from './chat-attachments';

const photo = {
  id: '9007199254744001',
  messageId: wireMessage.id,
  kind: 'image/jpeg',
  url: 'https://media.invalid/photo.jpg',
  fileName: 'photo.jpg',
  size: 10,
  order: 0,
  messageCreatedAt: wireMessage.createdAt,
  sender: wireMessage.sender,
};
const video = {
  ...photo,
  id: '9007199254744002',
  kind: 'video/mp4',
  url: 'https://media.invalid/video.mp4',
  fileName: 'video.mp4',
  order: 1,
};
const second = { ...photo, id: '9007199254744003', url: 'https://media.invalid/second.jpg', order: 2 };

describe('ChatAttachments media viewer', () => {
  let http: HttpTestingController;
  const present = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockResolvedValue({ present });
  beforeEach(() => {
    create.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: ModalController, useValue: { create } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  async function open() {
    const fixture = TestBed.createComponent(ChatAttachments);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http
      .expectOne((req) => req.url.endsWith('/attachments'))
      .flush({ attachments: [{ ...second }, { ...photo, id: '9007199254744004', messageId: '9007199254741005' }] });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }
  it('fetches the clicked message and opens its full mixed album rather than the media tab contents', async () => {
    const fixture = await open();
    const item = fixture.componentInstance['items']()[0];
    const operation = fixture.componentInstance['view'](item);
    await fixture.componentInstance['view'](item);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.opening ion-spinner')).not.toBeNull();
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`)
      .flush({ ...wireMessage, attachments: [{ ...photo }, { ...video }, { ...second }], hasAttachments: true });
    await operation;
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cssClass: 'media-viewer-overlay',
        animated: false,
        componentProps: {
          media: [
            expect.objectContaining({ kind: MediaKind.Image, url: photo.url }),
            expect.objectContaining({ kind: MediaKind.Video }),
            expect.objectContaining({ url: second.url }),
          ],
          initial: 2,
        },
      }),
    );
    expect(fixture.componentInstance['opening']()).toBeUndefined();
  });
  it('offers a retry on the clicked tile if its message cannot be read', async () => {
    const fixture = await open();
    const item = fixture.componentInstance['items']()[0];
    const operation = fixture.componentInstance['view'](item);
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`)
      .flush({}, { status: 503, statusText: 'Unavailable' });
    await operation;
    expect(create).not.toHaveBeenCalled();
    expect(fixture.componentInstance['openFailed']()).toBe(true);
    expect(fixture.componentInstance['opening']()).toBeUndefined();
    const retry = fixture.componentInstance['view'](item);
    http
      .expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`)
      .flush({ ...wireMessage, attachments: [{ ...second }] });
    await retry;
    expect(create).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['openFailed']()).toBe(false);
  });
  it('does not navigate from a stale attachment after switching media tabs', async () => {
    const fixture = await open();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const operation = fixture.componentInstance['locate'](fixture.componentInstance['items']()[0]);
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    fixture.componentRef.setInput('kind', ChatAttachmentKindFilter.video);
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/attachments')).flush({ attachments: [] });
    request.flush(structuredClone(wireMessage));
    await operation;
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.componentInstance['locateFailed']()).toBe(false);
  });

  it('does not open a viewer after its source component is destroyed', async () => {
    const fixture = await open();
    const operation = fixture.componentInstance['view'](fixture.componentInstance['items']()[0]);
    const request = http.expectOne(`/_api/chats/${wireChat.id}/messages/${wireMessage.id}`);
    fixture.destroy();
    await operation;
    expect(request.cancelled).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
});
