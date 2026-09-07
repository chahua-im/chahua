import { encodeId } from '../../api/snowflake-id';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { MessageType, type MessagePreview } from '../../../generated/models';
import { testMessage } from '../../api/testing';
import { Message } from './message';

describe('Message', () => {
  afterEach(() => vi.useRealTimers());

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

  it('shows identity only on the first message and the avatar and tail only on the last', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('last', false);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.sender')?.textContent).toContain('小茶');
    expect(element.querySelector('.sender-group')?.textContent).toContain('Lv.3');
    expect(element.querySelector('.gender')?.getAttribute('aria-label')).toBe('女');
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

  it('shows every message avatar immediately when the preference changes and keeps menu previews hidden', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('last', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.avatar')).toBeNull();
    fixture.componentRef.setInput('showAllAvatars', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.avatar img')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.chat-row.last')).not.toBeNull();
    fixture.componentRef.setInput('preview', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.avatar')).toBeNull();
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
    expect(element.querySelector('.message-text')?.textContent).toBe('消息已删除');
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
    expect(entry.getAttribute('aria-label')).toBe('12 条回复');
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
  ] as const)('shares the time and reaction placement for %s / %s / %j', async (kind, type, caption, overlay) => {
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
    expect(!!element.querySelector('.bubble .message-footer time')).toBe(!overlay);
    expect(!!element.querySelector('.bubble app-message-reactions')).toBe(!overlay);
    expect(!!element.querySelector('.message-stack > app-message-reactions.external')).toBe(overlay);
    expect(element.querySelectorAll('time')).toHaveLength(1);
  });

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
    const reaction = element.querySelector<HTMLButtonElement>('.external .reaction')!;
    const react = vi.fn();
    fixture.componentInstance.react.subscribe(react);
    reaction.click();
    expect(react).toHaveBeenCalledWith('❤️');
  });

  it('opens the message menu by right click or keyboard with the measured bubble and group position', async () => {
    const fixture = await render();
    fixture.componentRef.setInput('first', false);
    fixture.componentRef.setInput('own', true);
    fixture.detectChanges();
    const bubble = fixture.nativeElement.querySelector('.bubble') as HTMLElement;
    const rect = new DOMRect(20, 30, 180, 80);
    vi.spyOn(bubble, 'getBoundingClientRect').mockReturnValue(rect);
    const menu = vi.fn();
    fixture.componentInstance.menu.subscribe(menu);
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    bubble.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
    expect(menu).toHaveBeenLastCalledWith({
      messageId: fixture.componentInstance.message().id,
      element: bubble,
      rect,
      first: false,
      last: true,
      own: true,
    });
    for (const options of [{ key: 'F10', shiftKey: true }, { key: 'ContextMenu' }]) {
      const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true });
      bubble.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(menu).toHaveBeenCalledTimes(3);
    fixture.componentRef.setInput('message', { ...testMessage, messageType: MessageType.system });
    fixture.detectChanges();
    fixture.nativeElement.dispatchEvent(context);
    expect(menu).toHaveBeenCalledTimes(3);
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
    expect(reaction.getAttribute('aria-pressed')).toBe('true');
    const react = vi.fn();
    fixture.componentInstance.react.subscribe(react);
    reaction.click();
    expect(react).toHaveBeenCalledWith('👍');
    fixture.componentRef.setInput('message', { ...message, isDeleted: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.reactions')).toBeNull();
  });

  it('renders an inert preview without avatars or actions while preserving quotes and reaction counts', async () => {
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
    expect(bubble.hasAttribute('tabindex')).toBe(false);
    expect(element.querySelector('ion-avatar, .avatar-spacer, .reply-button, ion-button')).toBeNull();
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
});
