import { encodeId } from '../../api/snowflake-id';
import { TestBed } from '@angular/core/testing';
import { MessageType } from '../../../generated/models';
import type { AttachmentResponse, MessageResponse } from '../../../generated/models';
import { testMessage } from '../../api/testing';
import { MessageAttachments } from './message-attachments';

const image: AttachmentResponse = {
  id: encodeId('9007199254741101'),
  kind: 'image/jpeg',
  url: 'https://example.com/photo.jpg',
  width: 1200,
  height: 800,
  size: 2048,
  fileName: '照片.jpg',
};

describe('MessageAttachments', () => {
  async function render(message: Partial<MessageResponse>) {
    await TestBed.configureTestingModule({ imports: [MessageAttachments] }).compileComponents();
    const fixture = TestBed.createComponent(MessageAttachments);
    fixture.componentRef.setInput('message', { ...testMessage, ...message });
    fixture.detectChanges();
    return fixture;
  }

  it('reserves each image and video ratio in attachment order before loading', async () => {
    const fixture = await render({
      attachments: [
        image,
        {
          ...image,
          id: encodeId('9007199254741103'),
          kind: 'video/mp4',
          url: 'https://example.com/video.mp4',
          width: 1080,
          height: 1920,
        },
      ],
    });
    const element: HTMLElement = fixture.nativeElement;
    const frames = element.querySelectorAll<HTMLElement>('.media-frame');
    expect(frames[0].style.width).toBe('360px');
    expect(frames[0].style.aspectRatio).toBe('1200 / 800');
    expect(frames[1].style.width).toBe('202.5px');
    expect(frames[1].style.aspectRatio).toBe('1080 / 1920');
    expect(element.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    const video = element.querySelector('video')!;
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(false);
    const before = frames[1].getAttribute('style');
    video.dispatchEvent(new Event('loadedmetadata'));
    fixture.detectChanges();
    expect(frames[1].getAttribute('style')).toBe(before);
  });

  it('preserves the frame on image failure and offers the original file', async () => {
    const fixture = await render({ attachments: [image] });
    const element: HTMLElement = fixture.nativeElement;
    const frame = element.querySelector('.media-frame')!;
    const before = frame.getAttribute('style');
    element.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(frame.getAttribute('style')).toBe(before);
    expect(element.querySelector('.media-error')?.getAttribute('href')).toBe(image.url);
  });

  it('anchors one overlay timestamp to the last media frame in an album', async () => {
    const fixture = await render({
      message: '',
      attachments: [image, { ...image, id: encodeId('9007199254741103'), width: 600, height: 1200 }],
    });
    fixture.componentRef.setInput('overlayTime', true);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const frames = element.querySelectorAll('.media-frame');
    expect(frames[0].querySelector('time')).toBeNull();
    expect(frames[1].querySelector('time')?.getAttribute('datetime')).toBe(testMessage.createdAt);
    expect(element.querySelectorAll('time')).toHaveLength(1);
  });

  it('plays video stickers silently in a loop and gives missing dimensions a stable square', async () => {
    const fixture = await render({
      messageType: MessageType.sticker,
      sticker: {
        id: encodeId('9007199254741105'),
        emoji: '🙂',
        isFavorited: false,
        createdAt: testMessage.createdAt,
        media: {
          id: encodeId('9007199254741107'),
          contentType: 'video/webm',
          url: 'https://example.com/sticker.webm?v=1',
          size: 123,
        },
      },
    });
    const element: HTMLElement = fixture.nativeElement;
    const frame = element.querySelector<HTMLElement>('.sticker')!;
    expect(frame.style.width).toBe('200px');
    expect(frame.style.aspectRatio).toBe('240 / 240');
    const video = element.querySelector('video')!;
    expect(video.controls).toBe(false);
    expect(video.autoplay && video.loop && video.muted).toBe(true);
  });

  it('keeps explicit file messages as download cards even when their MIME is image', async () => {
    const fixture = await render({ messageType: MessageType.file, attachments: [image] });
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('img')).toBeNull();
    const link = element.querySelector<HTMLAnchorElement>('.file')!;
    expect(link.href).toBe(image.url);
    expect(link.download).toBe(image.fileName);
    expect(link.textContent).toContain('2.0 KB');
  });

  it('renders voice attachments with native controls and a fixed error container', async () => {
    const fixture = await render({
      messageType: MessageType.audio,
      attachments: [{ ...image, kind: 'audio/ogg', url: 'https://example.com/voice.ogg' }],
    });
    const element: HTMLElement = fixture.nativeElement;
    const audio = element.querySelector('audio')!;
    expect(audio.controls).toBe(true);
    expect(audio.preload).toBe('none');
    expect(audio.src).toBe('https://example.com/voice.ogg');
    audio.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(element.querySelector('.audio-frame .media-error')).not.toBeNull();
  });
});
