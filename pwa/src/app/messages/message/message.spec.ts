import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ModalController } from '@ionic/angular';
import { alertCircleOutline, checkmarkOutline, cloudUploadOutline, timeOutline } from 'ionicons/icons';
import { vi } from 'vitest';
import { AttachmentUploadPurpose, MessageType, type MessagePreview } from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { testMessage } from '../../api/testing';
import { MessageDelivery } from '../message-delivery';
import { UploadStatus, type AttachmentUpload } from '../upload';
import { Message, type MessageContent } from './message';

describe('Message', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function pointer(element: HTMLElement, type: string, options: PointerEventInit = {}) {
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
        clientX: 50,
        clientY: 50,
        ...options,
      }),
    );
  }

  async function render() {
    await TestBed.configureTestingModule({
      imports: [Message],
    }).compileComponents();
    const fixture = TestBed.createComponent(Message);
    fixture.componentRef.setInput('message', {
      ...testMessage,
      createdAt: new Date(2026, 8, 5, 9, 7).toISOString(),
      sender: {
        uid: 2,
        name: '小茶',
        gender: 2,
        avatarUrl: 'https://example.com/avatar.jpg',
        userGroup: { groupId: 3, name: 'Lv.3', chatGroupColor: '#4e92cc' },
      },
    });
    fixture.componentRef.setInput('own', false);
    fixture.detectChanges();
    return fixture;
  }

  it('replies after a left swipe starting on a mention and suppresses the following tap', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('message', {
      ...testMessage,
      message: '@[uid:2]',
      mentions: [{ uid: 2, username: '朋友', gender: 0 }],
    });
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.chat-row') as HTMLElement;
    row.setPointerCapture = vi.fn();
    const mention = row.querySelector('app-message-text button') as HTMLElement;
    const replied = vi.fn();
    fixture.componentInstance.reply.subscribe(replied);
    pointer(mention, 'pointerdown', { clientX: 150 });
    pointer(mention, 'pointermove', { clientX: 80 });
    fixture.detectChanges();
    expect(row.style.transform).toBe('translateX(-70px)');
    expect(fixture.nativeElement.querySelector('.swipe-reply.burst')).not.toBeNull();
    pointer(row, 'pointerup', { clientX: 80 });
    expect(replied).toHaveBeenCalledOnce();
    const clicked = vi.fn();
    mention.addEventListener('click', clicked);
    mention.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(clicked).not.toHaveBeenCalled();
  });

  it('keeps vertical scrolling from activating swipe reply', async () => {
    const fixture = await render();
    const bubble = fixture.nativeElement.querySelector('.bubble') as HTMLElement;
    const replied = vi.fn();
    fixture.componentInstance.reply.subscribe(replied);
    pointer(bubble, 'pointerdown', { clientX: 150 });
    pointer(bubble, 'pointermove', { clientX: 148, clientY: 80 });
    pointer(bubble, 'pointermove', { clientX: 70, clientY: 80 });
    pointer(bubble, 'pointerup');
    fixture.detectChanges();
    expect(replied).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.chat-row').style.transform).toBe('');
  });

  it('shows identity only on the first message and the avatar and tail only on the last', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('last', false);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.sender')?.textContent).toContain('小茶');
    expect(element.querySelector('.sender-group')?.textContent).toContain('Lv.3');
    expect(element.querySelector('.gender')?.classList.contains('female')).toBe(true);
    expect(element.querySelector('ion-avatar')).toBeNull();
    expect(element.querySelector('.chat-row.last')).toBeNull();
    expect(element.querySelector('time')?.textContent?.trim()).toBe('09:07');

    fixture.componentRef.setInput('first', false);
    fixture.componentRef.setInput('last', true);
    fixture.componentRef.setInput('own', true);
    fixture.detectChanges();
    expect(element.querySelector('.sender')).toBeNull();
    expect(element.querySelector('.chat-row.sent.last')).not.toBeNull();
    expect(element.querySelector('ion-avatar img')?.getAttribute('src')).toBe('https://example.com/avatar.jpg');
  });

  it('renders a quote, emits reply selection, and hides deleted quotes', async () => {
    const fixture = await render();
    const quote: MessagePreview = {
      ...testMessage,
      mentions: [],
      message: '原来的消息',
      sender: { uid: 3, name: '小花', gender: 0 },
    };
    fixture.componentRef.setInput('message', { ...testMessage, replyToMessage: quote });
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.reply-name')?.textContent).toBe('小花');
    expect(element.querySelector('.reply-text')?.textContent).toBe('原来的消息');
    const jumped = vi.fn();
    fixture.componentInstance.jump.subscribe(jumped);
    element.querySelector<HTMLButtonElement>('.reply-preview')?.click();
    expect(jumped).toHaveBeenCalledWith(quote.id);
    const selected = vi.fn();
    fixture.componentInstance.reply.subscribe(selected);
    element.querySelector<HTMLButtonElement>('.reply-button')?.click();
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: testMessage.id }));

    fixture.componentRef.setInput('message', { ...testMessage, replyToMessage: { ...quote, isDeleted: true } });
    fixture.detectChanges();
    expect(element.querySelector('.reply-preview')).toBeNull();
  });

  it('shows every message avatar immediately when the preference changes', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('last', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.avatar')).toBeNull();
    fixture.componentRef.setInput('showAllAvatars', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.avatar img')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.chat-row.last')).not.toBeNull();
    fixture.componentRef.setInput('showAllAvatars', false);
  });

  it('renders attachments with captions and suppresses all media on deletion', async () => {
    const fixture = await render();
    const message = {
      ...testMessage,
      message: '图片说明 🙂',
      attachments: [
        {
          id: encodeId('9007199254741101'),
          kind: 'image/jpeg',
          url: 'https://example.com/photo.jpg',
          width: 1200,
          height: 800,
          size: 2048,
          fileName: '照片.jpg',
        },
      ],
    };
    fixture.componentRef.setInput('message', message);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('app-message-attachments img')).not.toBeNull();
    expect(element.querySelector('.message-text')?.textContent).toBe('图片说明 🙂');
    fixture.componentRef.setInput('message', { ...message, isDeleted: true });
    fixture.detectChanges();
    expect(element.querySelector('app-message-attachments')).toBeNull();
    expect(element.querySelector('.chat-row, .system-message')).toBeNull();
    expect(element.textContent?.trim()).toBe('');
  });

  it('opens a topic from a root message and hides the entry inside topics or deleted messages', async () => {
    const fixture = await render();
    const open = vi.fn();
    fixture.componentInstance.openThread.subscribe(open);
    fixture.componentRef.setInput('canOpenThread', true);
    fixture.componentRef.setInput('message', {
      ...testMessage,
      threadInfo: { replyCount: 12 },
      reactions: [{ emoji: '👍', count: 3 }],
    });
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const entry = element.querySelector<HTMLButtonElement>('.thread-entry')!;
    expect(entry.textContent).toContain('12 条回复');
    expect(entry.textContent).toContain('12');
    expect(entry.querySelectorAll('ion-avatar')).toHaveLength(0);
    expect(element.querySelector('.bubble')?.lastElementChild?.tagName).toBe('APP-MESSAGE-THREAD');
    entry.click();
    expect(open).toHaveBeenCalledWith(testMessage.id);
    fixture.componentRef.setInput('canOpenThread', false);
    fixture.detectChanges();
    expect(element.querySelector('.thread-entry')).toBeNull();
    fixture.componentRef.setInput('canOpenThread', true);
    fixture.componentRef.setInput('message', { ...testMessage, isDeleted: true });
    fixture.detectChanges();
    expect(element.querySelector('.thread-entry')).toBeNull();

    fixture.componentRef.setInput('message', testMessage);
    fixture.detectChanges();
    expect(element.querySelector('.thread-entry')).toBeNull();
    expect(element.textContent).not.toContain('发起话题');
  });

  it.each([
    ['image/jpeg', MessageType.text, '', true],
    ['video/mp4', MessageType.text, '   ', true],
    ['image/jpeg', MessageType.text, '图片说明', false],
    ['image/jpeg', MessageType.file, '', false],
    ['audio/ogg', MessageType.audio, '', false],
    ['application/pdf', MessageType.file, '', false],
  ] as const)(
    'keeps reactions below the bubble and time with the content for %s / %s / %j',
    async (kind, type, caption, overlay) => {
      const fixture = await render();
      fixture.componentRef.setInput('message', {
        ...testMessage,
        messageType: type,
        message: caption,
        attachments: [
          {
            id: encodeId('9007199254741101'),
            kind,
            url: 'https://example.com/media',
            width: 1200,
            height: 800,
            size: 2048,
            fileName: '附件',
          },
        ],
        reactions: [{ emoji: '👍', count: 3 }],
      });
      fixture.detectChanges();
      const element: HTMLElement = fixture.nativeElement;
      expect(!!element.querySelector('.media-time time')).toBe(overlay);
      expect(!!element.querySelector('.bubble .message-body time')).toBe(!overlay);
      expect(element.querySelector('.bubble app-message-reactions')).toBeNull();
      expect(element.querySelector('.chat-row > app-message-reactions')).not.toBeNull();
      expect(element.querySelectorAll('time')).toHaveLength(1);
      fixture.componentRef.setInput('own', true);
      fixture.componentRef.setInput('delivery', MessageDelivery.Sending);
      fixture.detectChanges();
      expect(element.querySelectorAll('app-message-status ion-icon')).toHaveLength(1);
      expect(fixture.debugElement.query(By.css('app-message-status ion-icon')).componentInstance.icon).toBe(
        timeOutline,
      );
    },
  );

  it('keeps sticker reactions outside the transparent media and its timestamp on the sticker', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('message', {
      ...testMessage,
      messageType: MessageType.sticker,
      message: '',
      sticker: {
        id: encodeId('9007199254741105'),
        emoji: '🙂',
        isFavorited: false,
        createdAt: testMessage.createdAt,
        media: {
          id: encodeId('9007199254741107'),
          contentType: 'image/webp',
          url: 'https://example.com/sticker.webp',
          size: 123,
        },
      },
      reactions: [{ emoji: '❤️', count: 1, reactedByMe: true }],
    });
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.bubble')).toBeNull();
    expect(element.querySelector('.sticker-content .media-time')).not.toBeNull();
    expect(element.querySelector('.sticker-content app-message-reactions')).toBeNull();
    const reaction = element.querySelector<HTMLButtonElement>('app-message-reactions .reaction')!;
    const react = vi.fn();
    fixture.componentInstance.react.subscribe(react);
    reaction.click();
    expect(react).toHaveBeenCalledWith('❤️');
    fixture.componentRef.setInput('own', true);
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('.media-time app-message-status ion-icon')).componentInstance.icon).toBe(
      checkmarkOutline,
    );
    fixture.componentRef.setInput('preview', true);
    fixture.detectChanges();
    expect(element.querySelector('.bubble .sender')).not.toBeNull();
    expect(element.querySelector('.avatar')).not.toBeNull();
    expect(element.querySelector('.sticker-content')).toBeNull();
  });

  it('opens the message menu with the measured bubble and click position', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('first', false);
    fixture.componentRef.setInput('own', true);
    fixture.detectChanges();
    const bubble = fixture.nativeElement.querySelector('.bubble') as HTMLElement;
    const rect = new DOMRect(20, 30, 180, 80);
    vi.spyOn(bubble, 'getBoundingClientRect').mockReturnValue(rect);
    const menu = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 110, clientY: 150 });
    bubble.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
    expect(menu).toHaveBeenLastCalledWith({
      messageId: fixture.componentInstance.message().id,
      clientGeneratedId: undefined,
      element: bubble,
      rect,
      point: { x: 110, y: 150 },
      own: true,
    });
    expect(menu).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('message', { ...testMessage, messageType: MessageType.system });
    fixture.detectChanges();
    fixture.nativeElement.dispatchEvent(context);
    expect(menu).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, testMessage.id])('opens a queued message menu with its real IDs: server ID %s', async (id) => {
    const fixture = await render();
    fixture.componentRef.setInput('message', { ...testMessage, id, message: '待发送' });
    fixture.componentRef.setInput('outgoingId', 'queued-message');
    fixture.componentRef.setInput('interactive', false);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const bubble = element.querySelector<HTMLElement>('.bubble')!;
    const menu = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    bubble.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
    expect(menu).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        messageId: id,
        clientGeneratedId: 'queued-message',
        element: bubble,
      }),
    );
    expect(element.hasAttribute('data-message-id')).toBe(id != null);
  });

  it('opens a queued touch menu while profile, quote, reaction and swipe actions stay blocked', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('message', {
      ...testMessage,
      id: undefined,
      replyToMessage: { ...testMessage, mentions: [] },
      reactions: [{ emoji: '👍', count: 1 }],
      threadInfo: { replyCount: 1 },
    });
    fixture.componentRef.setInput('outgoingId', 'queued-message');
    fixture.componentRef.setInput('interactive', false);
    fixture.componentRef.setInput('canOpenThread', true);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const bubble = element.querySelector<HTMLElement>('.bubble')!;
    const menu = vi.fn();
    const serverAction = vi.fn();
    const profile = vi.spyOn(TestBed.inject(ModalController), 'create');
    fixture.componentInstance.menu.subscribe(menu);
    fixture.componentInstance.reply.subscribe(serverAction);
    fixture.componentInstance.jump.subscribe(serverAction);
    fixture.componentInstance.react.subscribe(serverAction);
    fixture.componentInstance.openThread.subscribe(serverAction);
    element.querySelector<HTMLButtonElement>('.reply-preview')!.click();
    element.querySelector<HTMLElement>('.avatar')!.click();
    expect(element.querySelector('.reply-button, button.reaction, .swipe-reply, .thread-entry')).toBeNull();
    vi.useFakeTimers();
    pointer(bubble, 'pointerdown', { clientX: 150 });
    vi.advanceTimersByTime(350);
    expect(menu).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ clientGeneratedId: 'queued-message', messageId: undefined, point: { x: 150, y: 50 } }),
    );
    bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menu).toHaveBeenCalledOnce();
    pointer(bubble, 'pointermove', { clientX: 70 });
    pointer(bubble, 'pointerup');
    expect(serverAction).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(element.querySelector<HTMLElement>('.chat-row')!.style.transform).toBe('');
  });

  it.each(['pointermove', 'pointercancel'])('cancels a queued touch menu after %s', async (type) => {
    const fixture = await render();
    fixture.componentRef.setInput('message', { ...testMessage, id: undefined });
    fixture.componentRef.setInput('outgoingId', 'queued-message');
    fixture.componentRef.setInput('interactive', false);
    fixture.detectChanges();
    const bubble = fixture.nativeElement.querySelector('.bubble') as HTMLElement;
    const menu = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    vi.useFakeTimers();
    pointer(bubble, 'pointerdown');
    vi.advanceTimersByTime(200);
    pointer(bubble, type, { clientY: 80 });
    vi.advanceTimersByTime(400);
    expect(menu).not.toHaveBeenCalled();
  });

  it('keeps queued previews from opening another menu', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('message', { ...testMessage, id: undefined });
    fixture.componentRef.setInput('outgoingId', 'queued-message');
    fixture.componentRef.setInput('preview', true);
    fixture.detectChanges();
    const bubble = fixture.nativeElement.querySelector('.bubble') as HTMLElement;
    const menu = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    vi.useFakeTimers();
    pointer(bubble, 'pointerdown');
    vi.advanceTimersByTime(400);
    expect(menu).not.toHaveBeenCalled();
  });

  it('opens once after a touch hold and suppresses its synthesized quote click without changing taps', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('message', { ...testMessage, replyToMessage: { ...testMessage, mentions: [] } });
    fixture.detectChanges();
    const quote = fixture.nativeElement.querySelector('.reply-preview') as HTMLElement;
    const menu = vi.fn();
    const jump = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    fixture.componentInstance.jump.subscribe(jump);
    vi.useFakeTimers();
    pointer(quote, 'pointerdown');
    vi.advanceTimersByTime(349);
    expect(menu).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(menu).toHaveBeenCalledOnce();
    quote.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menu).toHaveBeenCalledOnce();
    pointer(quote, 'pointerup');
    quote.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(jump).not.toHaveBeenCalled();
    pointer(quote, 'pointerdown');
    pointer(quote, 'pointerup');
    quote.click();
    expect(jump).toHaveBeenCalledWith(testMessage.id);
  });

  it.each([
    ['pointermove', { clientX: 61 }],
    ['pointermove', { clientY: 61 }],
    ['pointerup', {}],
    ['pointercancel', {}],
    ['pointerdown', { pointerId: 2, isPrimary: false }],
  ] as const)('cancels a pending hold after %s %j', async (type, options) => {
    const fixture = await render();
    const bubble = fixture.nativeElement.querySelector('.bubble') as HTMLElement;
    const menu = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    vi.useFakeTimers();
    pointer(bubble, 'pointerdown');
    vi.advanceTimersByTime(200);
    pointer(bubble, type, options);
    vi.advanceTimersByTime(400);
    expect(menu).not.toHaveBeenCalled();
  });

  it('clears a pending hold when destroyed and ignores mouse holds', async () => {
    const fixture = await render();
    const bubble = fixture.nativeElement.querySelector('.bubble') as HTMLElement;
    const menu = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    vi.useFakeTimers();
    pointer(bubble, 'pointerdown', { pointerType: 'mouse' });
    vi.advanceTimersByTime(400);
    expect(menu).not.toHaveBeenCalled();
    pointer(bubble, 'pointerdown');
    fixture.destroy();
    vi.advanceTimersByTime(400);
    expect(menu).not.toHaveBeenCalled();
  });

  it('shows reaction counts and own state, emits a toggle, and hides reactions on deleted messages', async () => {
    const fixture = await render();
    const message = { ...testMessage, reactions: [{ emoji: '👍', count: 3, reactedByMe: true }] };
    fixture.componentRef.setInput('message', message);
    fixture.detectChanges();
    const reaction = fixture.nativeElement.querySelector('.reaction') as HTMLButtonElement;
    expect(reaction.textContent).toMatch(/👍\s*3/);
    expect(reaction.classList.contains('reacted')).toBe(true);
    const react = vi.fn();
    fixture.componentInstance.react.subscribe(react);
    reaction.click();
    expect(react).toHaveBeenCalledWith('👍');
    fixture.componentRef.setInput('message', { ...message, isDeleted: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.reactions')).toBeNull();
  });

  it('shows up to five reaction avatars with overflow and a name when the avatar URL is absent', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('message', {
      ...testMessage,
      reactions: [
        {
          emoji: '👍',
          count: 7,
          reactors: Array.from({ length: 6 }, (_, i) => ({
            uid: i + 10,
            name: '小茶',
            avatarUrl: i ? `https://example.com/${i}.jpg` : undefined,
          })),
        },
      ],
    });
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('.reactor')).toHaveLength(5);
    expect(element.querySelectorAll('.reactor img')).toHaveLength(4);
    expect(element.querySelector('.reactor')?.textContent?.trim()).toBe('小');
    expect(element.querySelector('.overflow')?.textContent).toBe('+2');
    expect(element.querySelector('.count')).toBeNull();
    const react = vi.fn();
    fixture.componentInstance.react.subscribe(react);
    element.querySelector<HTMLImageElement>('.reactor img')!.click();
    expect(react).toHaveBeenCalledExactlyOnceWith('👍');
  });

  it.each([false, true])(
    'updates reaction avatars when the summary changes, including previews: %s',
    async (preview) => {
      const fixture = await render();
      fixture.componentRef.setInput('preview', preview);
      const setReactor = (uid: number) => {
        fixture.componentRef.setInput('message', {
          ...testMessage,
          reactions: [{ emoji: '❤️', count: 1, reactors: [{ uid, avatarUrl: `https://example.com/${uid}.jpg` }] }],
        });
        fixture.detectChanges();
      };
      setReactor(10);
      setReactor(20);
      const element: HTMLElement = fixture.nativeElement;
      expect(element.querySelectorAll('.reactor')).toHaveLength(1);
      expect(element.querySelector<HTMLImageElement>('.reactor img')?.src).toBe('https://example.com/20.jpg');
      expect(element.querySelector('.count, .overflow')).toBeNull();
      expect(element.querySelector('button.reaction') !== null).toBe(!preview);
    },
  );

  it('renders a full preview without actions while preserving quotes and reaction counts', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('preview', true);
    fixture.componentRef.setInput('canOpenThread', true);
    fixture.componentRef.setInput('message', {
      ...testMessage,
      replyToMessage: { ...testMessage, mentions: [] },
      reactions: [{ emoji: '❤️', count: 2, reactedByMe: true }],
    });
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const bubble = element.querySelector('.bubble') as HTMLElement;
    expect(bubble.hasAttribute('inert')).toBe(true);
    expect(element.querySelector('ion-avatar')).not.toBeNull();
    expect(element.querySelector('.reply-button, ion-button')).toBeNull();
    expect(element.querySelector('.reaction')?.textContent).toMatch(/❤️\s*2/);
    expect(element.querySelector('button.reaction')).toBeNull();
    const menu = vi.fn();
    const jump = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    fixture.componentInstance.jump.subscribe(jump);
    element.querySelector<HTMLButtonElement>('.reply-preview')?.click();
    bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    vi.useFakeTimers();
    pointer(bubble, 'pointerdown');
    vi.advanceTimersByTime(400);
    expect(menu).not.toHaveBeenCalled();
    expect(jump).not.toHaveBeenCalled();
  });

  it('defaults confirmed own messages to Sent and follows delivery changes after the timestamp', async () => {
    const fixture = await render();
    const element: HTMLElement = fixture.nativeElement;
    const icon = () =>
      fixture.debugElement.query(By.css('.timestamp app-message-status ion-icon'))?.componentInstance.icon;
    expect(icon()).toBeUndefined();
    fixture.componentRef.setInput('own', true);
    fixture.detectChanges();
    expect(icon()).toBe(checkmarkOutline);
    expect(element.querySelector('time')?.textContent).toContain('09:07');
    fixture.componentRef.setInput('delivery', MessageDelivery.Sending);
    fixture.detectChanges();
    expect(icon()).toBe(timeOutline);
    fixture.componentRef.setInput('delivery', MessageDelivery.Sent);
    fixture.detectChanges();
    expect(icon()).toBe(checkmarkOutline);
    fixture.componentRef.setInput('own', false);
    fixture.detectChanges();
    expect(icon()).toBeUndefined();
  });

  it.each([false, true])('keeps status in the text timestamp when reactions are present: %s', async (reactions) => {
    const fixture = await render();
    fixture.componentRef.setInput('own', true);
    fixture.componentRef.setInput('message', {
      ...testMessage,
      isEdited: true,
      reactions: reactions ? [{ emoji: '👍', count: 1 }] : [],
    });
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('time')).toHaveLength(1);
    expect(element.querySelector('time')?.textContent).toContain('已编辑');
    expect(element.querySelectorAll('time app-message-status ion-icon')).toHaveLength(1);
    expect(element.querySelector('.message-body time')).not.toBeNull();
    expect(element.querySelector('.bubble app-message-reactions')).toBeNull();
    expect(!!element.querySelector('.chat-row > app-message-reactions')).toBe(reactions);
  });

  it.each([
    [MessageType.text, undefined],
    [MessageType.text, 'image/jpeg'],
    [MessageType.text, 'video/mp4'],
    [MessageType.audio, 'audio/ogg'],
    [MessageType.file, 'application/pdf'],
    [MessageType.sticker, 'image/webp'],
  ])('offers message retry for failed %s / %s even while server interactions are disabled', async (type, kind) => {
    const fixture = await render();
    const message: MessageContent = {
      ...testMessage,
      id: undefined,
      messageType: type,
      message: kind ? '' : '待发送',
      attachments: kind ? [{ kind, url: 'blob:local-attachment', fileName: '附件', size: 5 }] : [],
    };
    fixture.componentRef.setInput('message', message);
    fixture.componentRef.setInput('own', true);
    fixture.componentRef.setInput('interactive', false);
    fixture.componentRef.setInput('delivery', MessageDelivery.Failed);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.hasAttribute('data-message-id')).toBe(false);
    expect(element.querySelectorAll('time')).toHaveLength(1);
    expect(fixture.debugElement.query(By.css('app-message-status ion-icon')).componentInstance.icon).toBe(
      alertCircleOutline,
    );
    const retry = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    const button = element.querySelector<HTMLButtonElement>('.retry-button')!;
    expect(button.textContent).toContain('发送失败');
    button.click();
    expect(retry).toHaveBeenCalledExactlyOnceWith(undefined);
    fixture.componentRef.setInput('delivery', MessageDelivery.Sending);
    fixture.detectChanges();
    expect(element.querySelector('.retry-button')).toBeNull();
    expect(element.querySelectorAll('app-message-status ion-icon')).toHaveLength(1);
    fixture.componentRef.setInput('delivery', MessageDelivery.Failed);
    fixture.componentRef.setInput('preview', true);
    fixture.detectChanges();
    expect(element.querySelector('.retry-button')).toBeNull();
  });

  it.each([
    [undefined, true],
    [undefined, false],
    [testMessage.id, false],
  ])('blocks server actions for message ID %s and interactive %s', async (id, interactive) => {
    const fixture = await render();
    fixture.componentRef.setInput('message', {
      ...testMessage,
      id,
      replyToMessage: { ...testMessage, mentions: [] },
      reactions: [{ emoji: '👍', count: 1 }],
      threadInfo: { replyCount: 1 },
    });
    fixture.componentRef.setInput('own', true);
    fixture.componentRef.setInput('interactive', interactive);
    fixture.componentRef.setInput('canOpenThread', true);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.hasAttribute('data-message-id')).toBe(id != null);
    expect(element.querySelector('.reply-button, button.reaction, .swipe-reply')).toBeNull();
    const emitted = vi.fn();
    fixture.componentInstance.menu.subscribe(emitted);
    fixture.componentInstance.reply.subscribe(emitted);
    fixture.componentInstance.jump.subscribe(emitted);
    fixture.componentInstance.react.subscribe(emitted);
    fixture.componentInstance.openThread.subscribe(emitted);
    element.querySelector<HTMLButtonElement>('.reply-preview')!.click();
    element.querySelector<HTMLButtonElement>('.thread-entry')?.click();
    element.querySelector<HTMLElement>('.avatar')?.click();
    const bubble = element.querySelector<HTMLElement>('.bubble')!;
    bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    vi.useFakeTimers();
    pointer(bubble, 'pointerdown', { clientX: 150 });
    vi.advanceTimersByTime(400);
    pointer(bubble, 'pointermove', { clientX: 70 });
    pointer(bubble, 'pointerup');
    expect(emitted).not.toHaveBeenCalled();
    if (id == null) {
      expect(element.querySelector('app-message-status ion-icon, .thread-entry')).toBeNull();
    }
  });

  it.each(['', '图片说明'])('shows upload, send, confirmation and failure status with caption %j', async (caption) => {
    const fixture = await render();
    const upload = {
      file: new File(['image'], '图片.jpg', { type: 'image/jpeg' }),
      url: 'blob:pending-image',
      purpose: AttachmentUploadPurpose.media,
      state: signal<ReturnType<AttachmentUpload['state']>>({ status: UploadStatus.Processing, progress: 0 }),
      retry: vi.fn<AttachmentUpload['retry']>(),
    } satisfies Pick<AttachmentUpload, 'file' | 'url' | 'purpose' | 'state' | 'retry'>;
    fixture.componentRef.setInput('message', {
      ...testMessage,
      id: undefined,
      message: caption,
      attachments: [{ kind: upload.file.type, url: upload.url, fileName: upload.file.name, size: upload.file.size }],
    });
    fixture.componentRef.setInput('uploads', [upload]);
    fixture.componentRef.setInput('own', true);
    fixture.componentRef.setInput('interactive', false);
    fixture.componentRef.setInput('delivery', MessageDelivery.Sending);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.media-frame .upload-overlay ion-spinner')).not.toBeNull();
    expect(element.querySelector('img')?.getAttribute('src')).toBe(upload.url);
    const icon = () => fixture.debugElement.query(By.css('app-message-status ion-icon')).componentInstance.icon;
    expect(icon()).toBe(cloudUploadOutline);
    upload.state.set({ status: UploadStatus.Uploading, progress: 0.5 });
    await fixture.whenStable();
    expect(icon()).toBe(cloudUploadOutline);
    expect(element.querySelector('.upload-overlay ion-spinner')).not.toBeNull();
    fixture.componentRef.setInput('delivery', MessageDelivery.Failed);
    fixture.detectChanges();
    expect(icon()).toBe(alertCircleOutline);
    expect(element.querySelector('.upload-overlay ion-spinner')).not.toBeNull();
    const retry = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    element.querySelector<HTMLButtonElement>('.retry-button')!.click();
    expect(retry).toHaveBeenCalledOnce();
    fixture.componentRef.setInput('delivery', MessageDelivery.Sending);
    fixture.detectChanges();
    expect(icon()).toBe(cloudUploadOutline);
    expect(element.querySelector('.retry-button')).toBeNull();
    upload.state.set({ status: UploadStatus.Ready, progress: 1, id: encodeId('9007199254741101') });
    await fixture.whenStable();
    expect(element.querySelector('.upload-overlay')).toBeNull();
    expect(fixture.componentInstance.delivery()).toBe(MessageDelivery.Sending);
    expect(icon()).toBe(timeOutline);
    fixture.componentRef.setInput('delivery', MessageDelivery.Sent);
    fixture.detectChanges();
    expect(icon()).toBe(checkmarkOutline);
  });
  it('waits for every upload and keeps confirmed and incoming messages from showing an upload status', async () => {
    const fixture = await render();
    const uploads = ['blob:first', 'blob:second'].map((url) => ({
      file: new File(['image'], '图片.jpg', { type: 'image/jpeg' }),
      url,
      purpose: AttachmentUploadPurpose.media,
      state: signal<ReturnType<AttachmentUpload['state']>>({ status: UploadStatus.Ready, progress: 1 }),
      retry: vi.fn<AttachmentUpload['retry']>(),
    }));
    uploads[1].state.set({ status: UploadStatus.Uploading, progress: 0.5 });
    fixture.componentRef.setInput('uploads', uploads);
    fixture.componentRef.setInput('own', true);
    fixture.componentRef.setInput('delivery', MessageDelivery.Sending);
    fixture.detectChanges();
    const icon = () => fixture.debugElement.query(By.css('app-message-status ion-icon'))?.componentInstance.icon;
    expect(icon()).toBe(cloudUploadOutline);
    uploads[1].state.set({ status: UploadStatus.Ready, progress: 1 });
    await fixture.whenStable();
    expect(icon()).toBe(timeOutline);
    uploads[0].state.set({ status: UploadStatus.Processing, progress: 0 });
    await fixture.whenStable();
    expect(icon()).toBe(cloudUploadOutline);
    fixture.componentRef.setInput('delivery', MessageDelivery.Sent);
    fixture.detectChanges();
    expect(icon()).toBe(checkmarkOutline);
    fixture.componentRef.setInput('delivery', undefined);
    fixture.detectChanges();
    expect(icon()).toBe(checkmarkOutline);
    fixture.componentRef.setInput('delivery', MessageDelivery.Sending);
    fixture.componentRef.setInput('own', false);
    fixture.detectChanges();
    expect(icon()).toBeUndefined();
  });
});
