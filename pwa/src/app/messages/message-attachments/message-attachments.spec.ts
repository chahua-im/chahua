import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ModalController } from '@ionic/angular';
import { vi } from 'vitest';
import type { AttachmentResponse, MessageResponse } from '../../../generated/models';
import { AttachmentUploadPurpose, MessageType } from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { testMessage } from '../../api/testing';
import { type AttachmentUpload, UploadStatus } from '../upload';
import { VoicePlayer } from '../voice-player/voice-player';
import { MediaKind } from './media-kind';
import { MessageAttachments, type MessageAttachmentSource } from './message-attachments';

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
  let resize: (width: number) => void;
  const disconnect = vi.fn();
  beforeEach(() => {
    disconnect.mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
          resize = (width) => callback([{ contentRect: { width } }]);
        }
        observe() {}
        disconnect = disconnect;
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  async function render(message: Partial<MessageResponse> | Partial<MessageAttachmentSource>) {
    await TestBed.configureTestingModule({ imports: [MessageAttachments] }).compileComponents();
    const fixture = TestBed.createComponent(MessageAttachments);
    fixture.componentRef.setInput('message', { ...testMessage, ...message });
    fixture.detectChanges();
    return fixture;
  }

  it('reserves an album before loading, resizes it without replacing media, and releases observation', async () => {
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
    expect(element.classList.contains('album')).toBe(true);
    expect(frames[0].style.top).toBe('0px');
    expect(frames[1].style.top).toBe('0px');
    expect(parseFloat(frames[0].style.width)).toBeGreaterThan(parseFloat(frames[1].style.width));
    expect(element.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    const video = element.querySelector('video')!;
    expect(video.controls).toBe(false);
    expect(video.autoplay).toBe(false);
    const before = frames[1].getAttribute('style');
    video.dispatchEvent(new Event('loadedmetadata'));
    fixture.detectChanges();
    expect(frames[1].getAttribute('style')).toBe(before);
    await fixture.whenStable();
    resize(282.5);
    await fixture.whenStable();
    expect(element.querySelector<HTMLElement>('.attachments')!.style.width).toBe('282px');
    expect(element.querySelector('video')).toBe(video);
    resize(0);
    await fixture.whenStable();
    expect(element.querySelector<HTMLElement>('.attachments')!.style.width).toBe('282px');
    fixture.destroy();
    expect(disconnect).toHaveBeenCalled();
  });

  it('preserves the frame on image failure and offers the original file', async () => {
    const fixture = await render({ attachments: [image] });
    const element: HTMLElement = fixture.nativeElement;
    const frame = element.querySelector('.media-frame')!;
    const before = frame.getAttribute('style');
    element.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(frame.getAttribute('style')).toBe(before);
    expect(element.querySelector('.media-error')?.textContent).toContain('加载失败，打开原文件');
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

  it('limits album previews to nine items while the viewer retains all media and the selected index', async () => {
    const attachments = Array.from({ length: 12 }, (_, index) => ({
      ...image,
      id: encodeId(String(100 + index)),
      url: `https://example.com/${index}.jpg`,
    }));
    const fixture = await render({ attachments });
    fixture.componentRef.setInput('overlayTime', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.media-frame')).toHaveLength(9);
    expect(fixture.nativeElement.querySelectorAll('time')).toHaveLength(1);
    const more: HTMLButtonElement = fixture.nativeElement.querySelector('.album-more');
    expect(more.textContent?.trim()).toBe('+3');
    const modal = Object.assign(document.createElement('ion-modal'), { present: vi.fn().mockResolvedValue(undefined) });
    const create = vi.spyOn(TestBed.inject(ModalController), 'create').mockResolvedValue(modal);
    more.click();
    await fixture.whenStable();
    const props = create.mock.calls[0][0].componentProps!;
    expect(props['media']).toHaveLength(12);
    expect(props['initial']).toBe(8);
    create.mockRestore();
  });

  it('keeps unknown album dimensions fixed when upload metadata arrives', async () => {
    const uploads = [upload('blob:a'), upload('blob:b')];
    const fixture = await render({
      attachments: uploads.map(({ url }) => ({ kind: 'image/jpeg', url, fileName: '图片', size: 1 })),
    });
    fixture.componentRef.setInput('uploads', uploads);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const before = [...element.querySelectorAll('.attachments, .media-frame')].map((node) =>
      node.getAttribute('style'),
    );
    expect(element.querySelector('.media-frame.cover')).toBeNull();
    uploads[0].state.set({ status: UploadStatus.Uploading, progress: 0.5, width: 800, height: 2000 });
    await fixture.whenStable();
    expect(
      [...element.querySelectorAll('.attachments, .media-frame')].map((node) => node.getAttribute('style')),
    ).toEqual(before);
    expect(element.querySelector('.media-frame.cover')).toBeNull();
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

  it('renders voice attachments with the waveform player inside a fixed container', async () => {
    const fixture = await render({
      messageType: MessageType.audio,
      attachments: [{ ...image, kind: 'audio/ogg', url: 'https://example.com/voice.ogg' }],
    });
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('audio')).toBeNull();
    const audio = fixture.debugElement.query(By.directive(VoicePlayer)).componentInstance as VoicePlayer;
    expect(audio.src()).toBe('https://example.com/voice.ogg');
  });

  function upload(url: string, kind = 'image/jpeg') {
    return {
      file: new File(['local'], '附件', { type: kind }),
      url,
      purpose: AttachmentUploadPurpose.media,
      state: signal<ReturnType<AttachmentUpload['state']>>({ status: UploadStatus.Processing, progress: 0 }),
      retry: vi.fn<AttachmentUpload['retry']>(),
    } satisfies Pick<AttachmentUpload, 'file' | 'url' | 'purpose' | 'state' | 'retry'>;
  }

  it.each([
    [MessageType.text, 'image/jpeg', '.media-frame', 'img'],
    [MessageType.text, 'video/mp4', '.media-frame', 'video'],
    [MessageType.audio, 'audio/ogg', '.audio-frame', 'app-voice-player'],
    [MessageType.file, 'application/pdf', '.file', 'a'],
  ])(
    'reacts to upload signals on each %s / %s attachment and preserves its blob preview',
    async (type, kind, frame, media) => {
      const local = upload('blob:local-preview', kind);
      const fixture = await render({
        messageType: type,
        attachments: [{ kind, url: local.url, fileName: local.file.name, size: local.file.size }],
      });
      fixture.componentRef.setInput('uploads', [local]);
      fixture.detectChanges();
      const element: HTMLElement = fixture.nativeElement;
      const node = element.querySelector(media)!;
      const attribute = media === 'a' ? 'href' : 'src';
      expect(
        media === 'app-voice-player'
          ? (fixture.debugElement.query(By.directive(VoicePlayer)).componentInstance as VoicePlayer).src()
          : node.getAttribute(attribute),
      ).toBe(local.url);
      expect(element.querySelectorAll(`${frame} app-upload-progress`)).toHaveLength(1);
      const ring = element.querySelector(`${frame} app-upload-progress`)!;
      expect(ring.querySelector('.progress')?.getAttribute('stroke-dashoffset')).toBe('100');
      expect(element.textContent).not.toMatch(/加载中|上传中|处理中/);
      local.state.set({ status: UploadStatus.Uploading, progress: 0.4, width: 600, height: 1200 });
      await fixture.whenStable();
      expect(element.querySelector(`${frame} app-upload-progress`)).toBe(ring);
      expect(ring.querySelector('.progress')?.getAttribute('stroke-dashoffset')).toBe('60');
      expect(element.querySelector(media)).toBe(node);
      if (frame === '.media-frame') {
        expect(element.querySelector<HTMLElement>(frame)?.style.aspectRatio).toBe('600 / 1200');
      }
      local.state.set({ status: UploadStatus.Failed, progress: 0.4 });
      await fixture.whenStable();
      expect(element.querySelector('app-upload-progress')).toBeNull();
      expect(
        media === 'app-voice-player'
          ? (fixture.debugElement.query(By.directive(VoicePlayer)).componentInstance as VoicePlayer).src()
          : node.getAttribute(attribute),
      ).toBe(local.url);
      local.state.set({ status: UploadStatus.Uploading, progress: 0 });
      await fixture.whenStable();
      expect(element.querySelector(`${frame} app-upload-progress`)).not.toBeNull();
      local.state.set({ status: UploadStatus.Ready, progress: 1, id: image.id });
      await fixture.whenStable();
      expect(element.querySelector('app-upload-progress')).toBeNull();
      expect(
        media === 'app-voice-player'
          ? (fixture.debugElement.query(By.directive(VoicePlayer)).componentInstance as VoicePlayer).src()
          : node.getAttribute(attribute),
      ).toBe(local.url);
      expect(local.retry).not.toHaveBeenCalled();
    },
  );

  it('matches multiple ID-less uploads by URL and does not clear media errors on progress', async () => {
    const first = upload('blob:first');
    const second = upload('blob:second');
    const fixture = await render({
      attachments: [first, second].map((item) => ({
        kind: item.file.type,
        url: item.url,
        fileName: item.file.name,
        size: item.file.size,
      })),
    });
    fixture.componentRef.setInput('uploads', [second, first]);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const frames = element.querySelectorAll('.media-frame');
    frames[0].querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    first.state.set({ status: UploadStatus.Ready, progress: 1, id: image.id });
    second.state.set({ status: UploadStatus.Uploading, progress: 0.6 });
    await fixture.whenStable();
    expect(frames[0].querySelector('app-upload-progress')).toBeNull();
    expect(frames[0].querySelector('.media-error')).not.toBeNull();
    expect(frames[0].querySelector('.media-error')?.getAttribute('href')).toBe(first.url);
    expect(frames[1].querySelector('app-upload-progress')).not.toBeNull();
    expect(frames[1].querySelector('img')?.getAttribute('src')).toBe(second.url);
  });

  it('opens the selected local image in an ID-less album using its URL', async () => {
    const fixture = await render({
      attachments: ['blob:first', 'blob:second'].map((url) => ({ kind: 'image/jpeg', url, fileName: '图片', size: 5 })),
    });
    const present = vi.fn().mockResolvedValue(undefined);
    const modal = Object.assign(document.createElement('ion-modal'), { present });
    const create = vi.spyOn(TestBed.inject(ModalController), 'create').mockResolvedValue(modal);
    const links = fixture.nativeElement.querySelectorAll('.media-frame a') as NodeListOf<HTMLAnchorElement>;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    links[1].dispatchEvent(event);
    await fixture.whenStable();
    expect(event.defaultPrevented).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        cssClass: 'media-viewer-overlay',
        animated: false,
        componentProps: {
          media: [expect.objectContaining({ url: 'blob:first' }), expect.objectContaining({ url: 'blob:second' })],
          initial: 1,
        },
      }),
    );
    expect(present).toHaveBeenCalledOnce();
    create.mockRestore();
  });

  it('opens a video with all images and videos from its message, excluding files', async () => {
    const fixture = await render({
      attachments: [
        image,
        { ...image, id: encodeId('9007199254741103'), url: 'https://example.com/clip.mp4', kind: 'video/mp4' },
        { ...image, id: encodeId('9007199254741105'), kind: 'application/pdf' },
      ],
    });
    const modal = Object.assign(document.createElement('ion-modal'), { present: vi.fn().mockResolvedValue(undefined) });
    const create = vi.spyOn(TestBed.inject(ModalController), 'create').mockResolvedValue(modal);
    fixture.nativeElement.querySelector('.video-open').click();
    await fixture.whenStable();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        cssClass: 'media-viewer-overlay',
        componentProps: {
          media: [
            expect.objectContaining({ kind: MediaKind.Image }),
            expect.objectContaining({ kind: MediaKind.Video }),
          ],
          initial: 1,
        },
      }),
    );
    create.mockRestore();
  });

  it.each([
    [MessageType.text, 'image/jpeg', 'img'],
    [MessageType.text, 'video/mp4', 'video'],
  ])('offers the original blob URL when a local %s / %s preview fails', async (type, kind, media) => {
    const fixture = await render({
      messageType: type,
      attachments: [{ kind, url: 'blob:failed-preview', fileName: '附件', size: 5 }],
    });
    const element: HTMLElement = fixture.nativeElement;
    element.querySelector(media)!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    const link = element.querySelector<HTMLAnchorElement>('a.media-error')!;
    expect(link.getAttribute('href')).toBe('blob:failed-preview');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener');
  });
});
