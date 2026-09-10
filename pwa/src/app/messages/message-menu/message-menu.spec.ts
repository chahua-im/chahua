import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { IonModal } from '@ionic/angular';
import { timeOutline } from 'ionicons/icons';
import { vi } from 'vitest';
import { GroupRole, MessageType, type MessageResponse } from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
import { testChat, testMessage, testUser } from '../../api/testing';
import { ChatStore } from '../../chats/chat-store';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { MessageActions } from '../message-actions';
import { MessageDelivery } from '../message-delivery';
import { MessageNotice } from '../message-notice';
import { MessageOutbox, type OutgoingMessage } from '../message-outbox';
import { Message, type MessageContent } from '../message/message';
import { MessageAction, MessageMenu } from './message-menu';

describe('MessageMenu', () => {
  let fixture: ComponentFixture<MessageMenu>;
  let menu: MessageMenu;
  const messages = signal([testMessage]);
  function setMessages(value: (typeof testMessage)[]) {
    messages.set(value);
    if (fixture && !fixture.componentRef.hostView.destroyed) fixture.componentRef.setInput('messages', value);
  }
  const admin = signal(false);
  const pinned = signal(false);
  const conversation = {
    items: messages,
    loading: signal(false),
    get: () => (pinned() ? { message: messages()[0] } : undefined),
    ensure: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  };
  const ensureDetails = vi.fn().mockResolvedValue(undefined);
  const outbox = {
    items: signal<OutgoingMessage[]>([]),
    cancel: vi.fn<(item: OutgoingMessage) => void>(),
  };
  const actions = {
    save: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue(undefined),
    toggleReaction: vi.fn().mockResolvedValue(undefined),
  };
  const selection = () => ({
    messageId: testMessage.id,
    element: document.createElement('div'),
    rect: new DOMRect(100, 200, 180, 70),
    own: false,
  });
  const labels = () =>
    [...fixture.nativeElement.querySelectorAll('.actions button')].map((button: Element) => button.textContent?.trim());

  beforeEach(async () => {
    vi.clearAllMocks();
    outbox.items.set([]);
    outbox.cancel.mockReset();
    setMessages([testMessage]);
    admin.set(false);
    pinned.set(false);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Drive the Angular modal template directly; native presentation is covered in the browser.
    vi.spyOn(IonModal.prototype, 'isOpen', 'set').mockImplementation(() => {});
    vi.spyOn(IonModal.prototype, 'dismiss').mockResolvedValue(true);
    await TestBed.configureTestingModule({
      imports: [MessageMenu],
      providers: [
        { provide: Preferences, useValue: { recentReactions: signal([]), rememberReaction: vi.fn() } },
        provideRouter([]),
        { provide: MessageOutbox, useValue: outbox },
        {
          provide: ChatStore,
          useValue: {
            pins: () => conversation,
            get: () => ({ myRole: admin() ? GroupRole.admin : GroupRole.member }),
            ensureDetails,
          },
        },
        { provide: SessionStore, useValue: { user: signal({ ...testUser, uid: testMessage.sender.uid + 1 }) } },
      ],
    })
      .overrideComponent(MessageMenu, {
        set: { providers: [{ provide: MessageActions, useValue: actions }] },
      })
      .compileComponents();
    fixture = TestBed.createComponent(MessageMenu);
    menu = fixture.componentInstance;
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('messages', messages());
    fixture.detectChanges();
    menu.open(selection());
    // Ionic mounts this template when the native overlay presents.
    const modal = fixture.debugElement.query(By.directive(IonModal));
    modal.nativeElement.dispatchEvent(new CustomEvent('ionMount'));
    fixture.detectChanges();
    const surface = fixture.nativeElement.querySelector('.menu-surface') as HTMLElement;
    if (surface) surface.style.padding = '0px';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function openQueued(
    message: MessageContent = {
      messageType: MessageType.text,
      message: '待发送的文字',
      sender: { ...testMessage.sender, uid: testMessage.sender.uid + 1 },
      createdAt: testMessage.createdAt,
      attachments: [],
    },
  ) {
    menu.reset();
    const content = signal(message);
    const cancelled = signal(false);
    const item = {
      clientGeneratedId: 'queued-message',
      chatId: testChat.id,
      message: content,
      uploads: [],
      delivery: signal(MessageDelivery.Sending),
      confirmed: signal<MessageResponse | undefined>(undefined),
      published: signal(false),
      cancelled,
      body: { clientGeneratedId: 'queued-message', messageType: message.messageType, message: message.message },
      disposed: false,
    } satisfies OutgoingMessage;
    outbox.items.set([item]);
    outbox.cancel.mockImplementation(() => cancelled.set(true));
    vi.clearAllMocks();
    menu.open({ ...selection(), messageId: message.id, clientGeneratedId: item.clientGeneratedId, own: true });
    fixture.detectChanges();
    return { item, content, cancelled };
  }

  it('offers only local text actions without loading permissions or pins', () => {
    admin.set(true);
    fixture.componentRef.setInput('canReply', false);
    const { content } = openQueued();
    expect(labels()).toEqual(['编辑', '复制', '撤回']);
    expect(fixture.nativeElement.querySelector('.reactions')).toBeNull();
    expect(fixture.nativeElement.querySelector('.actions button').disabled).toBe(false);
    const preview = fixture.debugElement.query(By.directive(Message)).componentInstance as Message<MessageContent>;
    expect(preview.message()).toBe(content());
    expect(preview.message()).not.toHaveProperty('id');
    expect(ensureDetails).not.toHaveBeenCalled();
    expect(conversation.ensure).not.toHaveBeenCalled();
  });

  it.each([
    [MessageType.audio, ['撤回']],
    [MessageType.sticker, ['撤回']],
    [MessageType.file, ['复制', '撤回']],
  ])('limits queued %s actions to its supported content', (messageType, expected) => {
    openQueued({
      messageType,
      message: '文件说明',
      sender: testMessage.sender,
      createdAt: testMessage.createdAt,
      attachments: [],
    });
    expect(labels()).toEqual(expected);
    expect(ensureDetails).not.toHaveBeenCalled();
    expect(conversation.ensure).not.toHaveBeenCalled();
  });

  it('delegates queued editing without cancelling the item or requiring server reply permission', async () => {
    fixture.componentRef.setInput('canReply', false);
    const { item } = openQueued();
    const editQueued = vi.fn();
    const edit = vi.fn();
    menu.editQueued.subscribe(editQueued);
    menu.edit.subscribe(edit);
    await menu['choose'](MessageAction.Edit);
    expect(editQueued).toHaveBeenCalledExactlyOnceWith(item);
    expect(edit).not.toHaveBeenCalled();
    expect(outbox.cancel).not.toHaveBeenCalled();
    expect(menu['selection']()).toBeUndefined();
  });

  it('cancels immediately without editing, server confirmation or a recalled-success notice', async () => {
    const { item, cancelled } = openQueued();
    const editQueued = vi.fn();
    menu.editQueued.subscribe(editQueued);
    let dismiss!: (result: boolean) => void;
    vi.mocked(IonModal.prototype.dismiss).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        dismiss = resolve;
      }),
    );
    const cancelling = menu['choose'](MessageAction.Recall);
    expect(outbox.cancel).toHaveBeenCalledExactlyOnceWith(item);
    expect(cancelled()).toBe(true);
    expect(menu['confirmation']()).toBeUndefined();
    expect(menu['notice']()).not.toBe(MessageNotice.Recalled);
    expect(editQueued).not.toHaveBeenCalled();
    expect(actions.recall).not.toHaveBeenCalled();
    dismiss(true);
    await cancelling;
    expect(menu['selection']()).toBeUndefined();
    expect(menu['message']()).toBeUndefined();
  });

  it('copies the current queued preview text synchronously without a server ID', async () => {
    const { content } = openQueued();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    content.update((message) => ({
      ...message,
      message: '修改后 @[uid:2]',
      mentions: [{ uid: 2, username: '小茶', gender: 0 }],
    }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview').textContent).toContain('修改后 @小茶');
    const copying = menu['choose'](MessageAction.Copy);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('修改后 @小茶');
    await copying;
    expect(menu['notice']()).toBe(MessageNotice.Copied);
    expect(ensureDetails).not.toHaveBeenCalled();
    expect(conversation.ensure).not.toHaveBeenCalled();
  });

  it('switches an open queued menu to the server message by client ID after acknowledgement', async () => {
    const { item, content } = openQueued();
    const confirmed: MessageResponse = {
      ...testMessage,
      id: encodeId('9007199254741201'),
      clientGeneratedId: item.clientGeneratedId,
      message: '服务器确认的文字',
      sender: content().sender,
    };
    setMessages([confirmed]);
    fixture.detectChanges();
    expect(labels()).toEqual(['编辑', '复制', '撤回']);
    expect(ensureDetails).not.toHaveBeenCalled();
    outbox.items.set([]);
    fixture.detectChanges();
    expect(menu['selection']()?.messageId).toBeUndefined();
    expect(menu['serverMessage']()).toBe(confirmed);
    expect(menu['message']()).toBe(confirmed);
    expect(labels()).toEqual(['回复', '编辑', '话题', '复制', '收藏', '链接', '撤回']);
    expect(ensureDetails).toHaveBeenCalledExactlyOnceWith(testChat.id);
    expect(conversation.ensure).toHaveBeenCalledOnce();
    await menu['choose'](MessageAction.Save);
    expect(actions.save).toHaveBeenCalledExactlyOnceWith(confirmed);
  });

  it('hides a cancelled queue item even while it remains in the outbox', () => {
    const { cancelled } = openQueued();
    cancelled.set(true);
    fixture.detectChanges();
    expect(outbox.items()).toHaveLength(1);
    expect(menu['queued']()).toBeUndefined();
    expect(menu['message']()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.menu-surface')).toBeNull();
    expect(ensureDetails).not.toHaveBeenCalled();
  });

  it('keeps server actions blocked while a queued edit shadows an existing server message', async () => {
    const { content } = openQueued({ ...testMessage, message: '编辑中的本地内容' });
    admin.set(true);
    fixture.detectChanges();
    expect(menu['serverMessage']()).toBe(testMessage);
    expect(menu['message']()).toBe(content());
    expect(
      (fixture.nativeElement.querySelector('.preview app-message-status ion-icon') as HTMLIonIconElement).icon,
    ).toBe(timeOutline);
    expect(labels()).toEqual(['编辑', '复制', '撤回']);
    const reply = vi.fn();
    const thread = vi.fn();
    menu.reply.subscribe(reply);
    menu.openThread.subscribe(thread);
    for (const action of [
      MessageAction.Reply,
      MessageAction.Thread,
      MessageAction.Pin,
      MessageAction.Save,
      MessageAction.Link,
    ]) {
      await menu['choose'](action);
    }
    await menu.reactTo(testMessage, '👍');
    expect(reply).not.toHaveBeenCalled();
    expect(thread).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.toggleReaction).not.toHaveBeenCalled();
    expect(menu['confirmation']()).toBeUndefined();
    expect(ensureDetails).not.toHaveBeenCalled();
    expect(conversation.ensure).not.toHaveBeenCalled();
  });

  it('prefers a matching server ID before falling back to the client ID', () => {
    const other = { ...testMessage, id: encodeId('9007199254741201'), clientGeneratedId: 'other-message' };
    setMessages([testMessage, other]);
    menu['selection'].set({ ...selection(), clientGeneratedId: other.clientGeneratedId });
    expect(menu['serverMessage']()).toBe(testMessage);
    menu['selection'].set({
      ...selection(),
      messageId: encodeId('9007199254741203'),
      clientGeneratedId: other.clientGeneratedId,
    });
    expect(menu['serverMessage']()).toBe(other);
  });

  it('shows member actions, then adds admin pin and recall actions in order', () => {
    expect(labels()).toEqual(['回复', '话题', '复制', '收藏', '链接']);
    admin.set(true);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '话题', '置顶', '复制', '收藏', '链接', '撤回']);
    pinned.set(true);
    fixture.detectChanges();
    expect(labels()).toContain('取消置顶');
  });

  it('keeps topic, deleted and special-message actions within their supported scope', () => {
    fixture.componentRef.setInput('threadId', encodeId('100'));
    fixture.detectChanges();
    expect(labels()).not.toContain('话题');
    admin.set(true);
    setMessages([{ ...testMessage, messageType: MessageType.sticker }]);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '链接', '撤回']);
    expect(fixture.nativeElement.querySelector('.reactions')).toBeNull();
    setMessages([{ ...testMessage, messageType: MessageType.invite }]);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '置顶', '撤回']);
    setMessages([{ ...testMessage, isDeleted: true }]);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '链接']);
  });

  it('toggles the selected reaction and delegates replying to its page', async () => {
    setMessages([{ ...testMessage, reactions: [{ emoji: '👍', count: 1, reactedByMe: true }] }]);
    fixture.detectChanges();
    const reply = vi.fn();
    menu.reply.subscribe(reply);
    const selected = fixture.nativeElement.querySelector('.reactions button.selected');
    expect(selected.textContent.trim()).toBe('👍');
    selected.click();
    expect(actions.toggleReaction).toHaveBeenCalledWith(messages()[0], '👍');
    await fixture.whenStable();
    menu.open(selection());
    await menu['choose'](MessageAction.Reply);
    expect(reply).toHaveBeenCalledWith(messages()[0]);
  });

  it('allows an admin to remove a deleted pin but never offers it to members', () => {
    setMessages([{ ...testMessage, isDeleted: true }]);
    pinned.set(true);
    fixture.detectChanges();
    expect(labels()).not.toContain('取消置顶');
    admin.set(true);
    fixture.detectChanges();
    expect(labels()).toContain('取消置顶');
  });

  it('keeps panels inside a narrow viewport and dismisses only backdrop clicks', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(276);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
    fixture.nativeElement.querySelector('.chat-row').style.gap = '10px';
    menu['selection'].set({ ...selection(), rect: new DOMRect(-50, -100, 1500, 70), own: true });
    fixture.detectChanges();
    TestBed.tick();
    const stack: HTMLElement = fixture.nativeElement.querySelector('.menu-stack');
    for (const panel of fixture.nativeElement.querySelectorAll('.panel') as NodeListOf<HTMLElement>) {
      const left = parseFloat(stack.style.left) + parseFloat(panel.style.left);
      expect(left).toBeGreaterThanOrEqual(12);
      expect(left + panel.offsetWidth).toBeLessThanOrEqual(window.innerWidth - 12);
    }
    expect(parseFloat(stack.style.top)).toBeGreaterThanOrEqual(12);
    expect(parseFloat(stack.style.width)).toBeLessThanOrEqual(window.innerWidth - 24);
    fixture.nativeElement.querySelector('.preview').click();
    expect(menu['selection']()).toBeDefined();
    fixture.nativeElement.querySelector('.menu-surface').click();
    await fixture.whenStable();
    expect(menu['selection']()).toBeUndefined();
  });

  it('shows complete identity in the overlay independently of the message group', () => {
    fixture.detectChanges();
    const preview = fixture.debugElement.query(By.directive(Message)).componentInstance as Message;
    expect(preview.first()).toBe(true);
    expect(preview.last()).toBe(true);
    expect(preview.preview()).toBe(true);
    expect(fixture.nativeElement.querySelector('.preview .sender')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.preview .avatar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.preview .chat-row.last')).not.toBeNull();
  });

  it('runs only the confirmed pin action and retains its intended state', async () => {
    admin.set(true);
    await menu['choose'](MessageAction.Pin);
    expect(conversation.set).not.toHaveBeenCalled();
    pinned.set(true);
    await menu['confirm'](new CustomEvent('didDismiss', { detail: { role: 'confirm' } }));
    expect(conversation.set).toHaveBeenCalledWith(testMessage, true);
    expect(menu['notice']()).toBe(MessageNotice.Pinned);
  });

  it('keeps feedback local and ignores completion after the owning page leaves', async () => {
    let finish!: () => void;
    actions.save.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = menu['choose'](MessageAction.Save);
    await Promise.resolve();
    await Promise.resolve();
    expect(menu.busy()).toBe(true);
    expect(menu['selection']()).toBeUndefined();
    await menu['choose'](MessageAction.Save);
    expect(actions.save).toHaveBeenCalledOnce();
    menu.reset();
    finish();
    await saving;
    expect(menu.busy()).toBe(false);
    expect(menu['notice']()).toBeUndefined();
    expect(menu['confirmation']()).toBeUndefined();
  });

  it('starts a clipboard write synchronously before dismissal completes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const copying = menu['choose'](MessageAction.Copy);
    expect(writeText).toHaveBeenCalledWith(testMessage.message);
    await copying;
    expect(menu['notice']()).toBe(MessageNotice.Copied);
  });
});
