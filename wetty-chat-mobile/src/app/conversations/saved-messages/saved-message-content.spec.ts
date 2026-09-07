import { TestBed } from '@angular/core/testing';
import { MessageType, type SavedMessageResponse } from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { Message } from '../../messages/message/message';
import { savedMessageContent } from './saved-message-content';

const snapshot: SavedMessageResponse = {
  id: encodeId('500'),
  originalChatId: encodeId('100'),
  originalMessageId: encodeId('200'),
  originalCreatedAt: '2026-08-01T12:00:00Z',
  originalSenderUid: 1,
  savedAt: '2026-09-07T12:00:00Z',
  canLocateContext: false,
  chat: { id: encodeId('100'), name: '保存时的群名' },
  sender: { uid: 1, name: '保存时的作者', gender: 0 },
  message: '收藏快照内容',
  messageType: MessageType.text,
  attachments: [],
  mentions: [],
};

describe('savedMessageContent rendered by Message', () => {
  async function render(message: SavedMessageResponse) {
    await TestBed.configureTestingModule({ imports: [Message] }).compileComponents();
    const fixture = TestBed.createComponent(Message);
    fixture.componentRef.setInput('message', savedMessageContent(message));
    fixture.componentRef.setInput('own', false);
    fixture.componentRef.setInput('interactive', false);
    fixture.detectChanges();
    return fixture;
  }

  it('renders snapshot metadata and original attachment downloads without a live message', async () => {
    const fixture = await render({
      ...snapshot,
      messageType: MessageType.file,
      attachments: [
        {
          id: encodeId('300'),
          externalReference: 'snapshot-file',
          order: 0,
          fileName: '记录.pdf',
          kind: 'application/pdf',
          size: 2048,
          url: 'https://example.com/saved-file.pdf',
        },
      ],
    });
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('保存时的作者');
    expect(element.textContent).toContain('收藏快照内容');
    expect(element.querySelector('time')?.getAttribute('datetime')).toBe(snapshot.originalCreatedAt);
    const download = element.querySelector<HTMLAnchorElement>('.file')!;
    expect(download.href).toBe('https://example.com/saved-file.pdf');
    expect(download.download).toBe('记录.pdf');
    expect(download.textContent).toContain('2.0 KB');
    expect(element.querySelector('.reply-button')).toBeNull();
    const menu = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.querySelector('.bubble')!.dispatchEvent(event);
    expect(menu).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(savedMessageContent(snapshot)).not.toHaveProperty('reactions');
  });

  it('plays a saved sticker using only the media fields available in its snapshot', async () => {
    const fixture = await render({
      ...snapshot,
      messageType: MessageType.sticker,
      message: undefined,
      sticker: {
        id: encodeId('300'),
        emoji: '🙂',
        mediaUrl: 'https://example.com/saved.webm',
        mediaContentType: 'video/webm',
      },
    });
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    expect(video.src).toBe('https://example.com/saved.webm');
    expect(video.autoplay && video.loop && video.muted).toBe(true);
    expect(video.controls).toBe(false);
  });
});
