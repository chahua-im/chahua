import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
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
  let resizePill: (width: number) => void;
  const disconnect = vi.fn();
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    disconnect.mockClear();
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: (entries: { target: Element; contentRect: { width: number } }[]) => void) {}
        observe(target: Element) {
          if (target.classList.contains('chat-row')) return;
          const notify = (width: number) => this.callback([{ target, contentRect: { width } }]);
          if (target.tagName === 'ION-BADGE') resizePill = notify;
          else resize = notify;
        }
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

  it('recomputes album height on viewport resize without changing album width', async () => {
    vi.stubGlobal('innerWidth', 360);
    vi.stubGlobal('innerHeight', 640);
    vi.stubGlobal('devicePixelRatio', 1);
    const fixture = await render({
      attachments: [image, { ...image, id: encodeId('9007199254741102'), url: '/second.jpg' }],
    });
    await fixture.whenStable();
    const gallery: HTMLElement = fixture.nativeElement.querySelector('.attachments');
    const width = gallery.style.width;
    const height = parseFloat(gallery.style.height);
    vi.stubGlobal('innerHeight', 960);
    window.dispatchEvent(new Event('resize'));
    await fixture.whenStable();
    expect(parseFloat(gallery.style.height)).toBeGreaterThan(height);
    expect(gallery.style.width).toBe(width);
    fixture.destroy();
  });

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
    expect(element.querySelector<HTMLElement>('.attachments')!.style.width).toBe('282.5px');
    expect(element.querySelector('video')).toBe(video);
    resize(0);
    await fixture.whenStable();
    expect(element.querySelector<HTMLElement>('.attachments')!.style.width).toBe('282.5px');
    fixture.destroy();
    expect(disconnect).toHaveBeenCalled();
  });

  it('sizes a three-screenshot host to the album and fills it without resize feedback', async () => {
    const fixture = await render({
      attachments: Array.from({ length: 3 }, (_, i) => ({
        ...image,
        id: encodeId(String(9200 + i)),
        width: 1080,
        height: 2400,
      })),
    });
    fixture.componentRef.setInput('overlayTime', true);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const intrinsicWidth = parseFloat(element.style.width);
    expect(intrinsicWidth).toBeGreaterThan(0);
    expect(intrinsicWidth).toBeLessThan(420);
    const gallery = element.querySelector<HTMLElement>('.attachments')!;
    expect(parseFloat(gallery.style.width)).toBe(intrinsicWidth);
    for (const width of [intrinsicWidth, intrinsicWidth, 240, 390, intrinsicWidth]) {
      resize(width);
      await fixture.whenStable();
      expect(parseFloat(element.style.width)).toBe(intrinsicWidth);
      expect(parseFloat(gallery.style.width)).toBe(width);
      const frames = [...element.querySelectorAll<HTMLElement>('.media-frame')];
      expect(Math.max(...frames.map((frame) => parseFloat(frame.style.left) + parseFloat(frame.style.width)))).toBe(
        width,
      );
      expect(frames[2].querySelector('.media-time')).toBeTruthy();
      expect(element.querySelectorAll('.media-time')).toHaveLength(1);
    }
  });

  it('fills every screenshot preview in a six-image album and opens the original dimensions', async () => {
    const attachments = Array.from({ length: 6 }, (_, i) => ({
      ...image,
      id: encodeId(String(9000 + i)),
      url: `https://example.com/screenshot-${i}.jpg`,
      width: 1080,
      height: 2400,
    }));
    const fixture = await render({ attachments });
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('.media-frame.cover')).toHaveLength(6);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    element.querySelectorAll<HTMLAnchorElement>('.media-frame a')[2].click();
    await fixture.whenStable();
    const state = navigate.mock.calls[0][1]!.state!;
    expect(state['initial']).toBe(2);
    expect(state['media']).toHaveLength(6);
    expect(state['media'][2]).toMatchObject({ width: 1080, height: 2400, url: attachments[2].url });
    navigate.mockRestore();
  });

  it('assigns the upstream rounding remainder to the outgoing edge', async () => {
    const fixture = await render({
      attachments: Array.from({ length: 6 }, (_, i) => ({
        ...image,
        id: encodeId(String(9100 + i)),
        width: 1080,
        height: 2400,
      })),
    });
    const element: HTMLElement = fixture.nativeElement;
    const frames = element.querySelectorAll<HTMLElement>('.media-frame');
    const incomingWidths = [...frames].map((frame) => parseFloat(frame.style.width));
    fixture.componentRef.setInput('outgoing', true);
    await fixture.whenStable();
    expect(parseFloat(frames[0].style.width)).toBeGreaterThan(incomingWidths[0]);
    expect(parseFloat(frames[2].style.width)).toBeLessThan(incomingWidths[2]);
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

  it('backs a stretched image with its own aspect ratio and removes the blurred gutters on failure', async () => {
    const fixture = await render({ attachments: [{ ...image, width: 1080, height: 2400 }] });
    const element: HTMLElement = fixture.nativeElement;
    expect(element.classList.contains('fill')).toBe(true);
    expect(element.style.width).toBe('189px');
    const frame = element.querySelector<HTMLElement>('.media-frame')!;
    expect(frame.classList.contains('fill')).toBe(true);
    expect(frame.style.width).toBe('');
    expect(frame.style.height).toBe('');
    expect(frame.style.aspectRatio).toBe('1080 / 2400');
    expect(frame.querySelector('.backdrop')).toBeTruthy();
    expect(frame.style.getPropertyValue('--media-aspect-ratio')).toBe('0.45');
    element.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(frame.querySelector('.backdrop')).toBeNull();
    expect(element.querySelector('.media-error')).toBeTruthy();
  });

  it('widens a captionless image bubble to twice its time pill', async () => {
    const fixture = await render({
      messageType: MessageType.text,
      message: '',
      attachments: [{ ...image, width: 40, height: 800 }],
    });
    fixture.componentRef.setInput('overlayTime', true);
    fixture.detectChanges();
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const pill = element.querySelector<HTMLElement>('ion-badge.media-time')!;
    pill.getBoundingClientRect = () => ({ width: 60, height: 20 }) as DOMRect;
    resizePill(60);
    fixture.detectChanges();
    expect(element.style.width).toBe('21px');
    expect(element.style.minWidth).toBe('120px');
  });

  it('keeps a narrow sticker unstretched', async () => {
    const fixture = await render({
      messageType: MessageType.sticker,
      sticker: {
        id: encodeId('9007199254741199'),
        emoji: '🐱',
        name: '猫',
        media: { ...image, contentType: 'image/png' },
      },
    });
    const element: HTMLElement = fixture.nativeElement;
    expect(element.classList.contains('fill')).toBe(false);
    expect(element.querySelector('.media-frame.fill')).toBeNull();
  });

  it('covers every album frame until its own media paints', async () => {
    const fixture = await render({
      attachments: [image, { ...image, id: encodeId('9007199254741102'), url: '/second.jpg' }],
    });
    const frames: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.media-frame');
    const media: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.media-frame img');
    expect(frames).toHaveLength(2);
    expect(frames[0].querySelector('.media-skeleton')).not.toBeNull();
    expect(frames[1].querySelector('.media-skeleton')).not.toBeNull();
    media[0].dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(media[0].classList.contains('loaded')).toBe(true);
    expect(media[1].classList.contains('loaded')).toBe(false);
  });

  it('settles a video placeholder once its metadata is available', async () => {
    const fixture = await render({
      attachments: [{ ...image, kind: 'video/mp4', url: '/clip.mp4', fileName: 'clip.mp4' }],
    });
    const video: HTMLVideoElement = fixture.nativeElement.querySelector('.media-frame video');
    expect(video.classList.contains('loaded')).toBe(false);
    video.dispatchEvent(new Event('loadedmetadata'));
    fixture.detectChanges();
    expect(video.classList.contains('loaded')).toBe(true);
  });

  it('covers a sticker until its media paints', async () => {
    const fixture = await render({
      messageType: MessageType.sticker,
      sticker: {
        id: encodeId('9007199254741201'),
        emoji: '🍵',
        name: '茶',
        media: { ...image, contentType: 'image/png' },
      },
    });
    const frame: HTMLElement = fixture.nativeElement.querySelector('.media-frame');
    const media = frame.querySelector('img')!;
    expect(frame.querySelector('.media-skeleton')).not.toBeNull();
    expect(media.classList.contains('loaded')).toBe(false);
    media.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(media.classList.contains('loaded')).toBe(true);
  });

  it('keeps multi-kind attachments unstretched', async () => {
    const fixture = await render({
      attachments: [
        image,
        {
          id: encodeId('9007199254741104'),
          kind: 'application/pdf',
          url: 'https://example.com/doc.pdf',
          size: 1,
          fileName: 'doc.pdf',
        },
      ],
    });
    const element: HTMLElement = fixture.nativeElement;
    expect(element.classList.contains('album')).toBe(false);
    expect(element.classList.contains('fill')).toBe(false);
    expect(element.querySelector('.media-frame.fill')).toBeNull();
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
    const create = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    more.click();
    await fixture.whenStable();
    const props = create.mock.calls[0][1]!.state!;
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
    expect(element.querySelectorAll('.media-frame.cover')).toHaveLength(2);
    uploads[0].state.set({ status: UploadStatus.Uploading, progress: 0.5, width: 800, height: 2000 });
    await fixture.whenStable();
    expect(
      [...element.querySelectorAll('.attachments, .media-frame')].map((node) => node.getAttribute('style')),
    ).toEqual(before);
    expect(element.querySelectorAll('.media-frame.cover')).toHaveLength(2);
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
    expect(frame.style.width).toBe('160px');
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
    const create = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const links = fixture.nativeElement.querySelectorAll('.media-frame a') as NodeListOf<HTMLAnchorElement>;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    links[1].dispatchEvent(event);
    await fixture.whenStable();
    expect(event.defaultPrevented).toBe(true);
    expect(create).toHaveBeenCalledWith(
      ['/media'],
      expect.objectContaining({
        state: {
          media: [expect.objectContaining({ url: 'blob:first' }), expect.objectContaining({ url: 'blob:second' })],
          initial: 1,
        },
      }),
    );
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
    const create = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.nativeElement.querySelector('.video-open').click();
    await fixture.whenStable();
    expect(create).toHaveBeenCalledWith(
      ['/media'],
      expect.objectContaining({
        state: {
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
