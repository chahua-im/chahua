import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { getPlatforms, IonModal } from '@ionic/angular';
import { timeOutline } from 'ionicons/icons';
import { vi } from 'vitest';
import { GroupKind, GroupRole, MessageType, SpeakingMode, type MessageResponse } from '../../../generated/models';
import { encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { testChat, testMessage, testUser } from '../../api/testing';
import { allowsSpeaking, SpeakingAction } from '../../chats/speaking';
import { ChatStore } from '../../chats/chat-store';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { MessageActions } from '../message-actions';
import { MessageDelivery } from '../message-delivery';
import { MessageNotice } from '../message-notice';
import { MessageOutbox, type OutgoingMessage } from '../message-outbox';
import { Message, type MessageContent } from '../message/message';
import { SavedMessageStore } from '../saved-message-store';
import { StickerFavorites } from '../sticker-favorites';
import { MessageAction, MessageMenu, pageSlots, type MenuSlot } from './message-menu';

describe('MessageMenu', () => {
  let fixture: ComponentFixture<MessageMenu>;
  let menu: MessageMenu;
  let authorWidth = 100;
  const messages = signal([testMessage]);
  function setMessages(value: (typeof testMessage)[]) {
    messages.set(value);
    if (fixture && !fixture.componentRef.hostView.destroyed) fixture.componentRef.setInput('messages', value);
  }
  const admin = signal(false);
  const pinned = signal(false);
  const kind = signal(GroupKind.group);
  const canDm = signal(true);
  const mode = signal(SpeakingMode.unrestricted);
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
    recall: vi.fn().mockResolvedValue(undefined),
    toggleReaction: vi.fn().mockResolvedValue(undefined),
  };
  const savedIds = signal<ReadonlySet<SnowflakeID>>(new Set());
  const savedLoading = signal(false);
  const favoriteIds = signal<ReadonlySet<SnowflakeID>>(new Set());
  const savedMessages = {
    ensure: vi.fn().mockResolvedValue(undefined),
    isSaved: (_chatId: SnowflakeID, messageId: SnowflakeID) => savedIds().has(messageId),
    loading: savedLoading,
    save: vi.fn().mockResolvedValue(undefined),
    unsave: vi.fn().mockResolvedValue(undefined),
  };
  const favoriteStickers = {
    ensure: vi.fn().mockResolvedValue(undefined),
    isFavorite: (stickerId: SnowflakeID) => favoriteIds().has(stickerId),
    loading: () => false,
    set: vi.fn().mockResolvedValue(undefined),
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
    savedLoading.set(false);
    authorWidth = 100;
    const computedStyle = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = computedStyle(element);
      return new Proxy(style, {
        get(target, property) {
          if (element.matches('.sender') && property === 'width') return `${authorWidth}px`;
          if (element.matches('.bubble-surface') && (property === 'paddingLeft' || property === 'paddingRight'))
            return '11px';
          return Reflect.get(target, property);
        },
      });
    });
    outbox.items.set([]);
    outbox.cancel.mockReset();
    savedIds.set(new Set());
    favoriteIds.set(new Set());
    setMessages([testMessage]);
    admin.set(false);
    pinned.set(false);
    kind.set(GroupKind.group);
    canDm.set(true);
    mode.set(SpeakingMode.unrestricted);
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
        { provide: SavedMessageStore, useValue: savedMessages },
        { provide: StickerFavorites, useValue: favoriteStickers },
        {
          provide: Preferences,
          useValue: {
            recentReactions: signal([]),
            pinnedReactions: signal(['👍']),
            rememberReaction: vi.fn(),
          },
        },
        provideRouter([]),
        { provide: MessageOutbox, useValue: outbox },
        {
          provide: ChatStore,
          useValue: {
            pins: () => conversation,
            canSpeak: (_id: SnowflakeID, action: SpeakingAction) =>
              kind() === GroupKind.dm || admin() || allowsSpeaking(mode(), action),
            get: () => ({
              kind: kind(),
              myRole: admin() ? GroupRole.admin : GroupRole.member,
              peer: kind() === GroupKind.dm ? { uid: 2, username: '朋友' } : undefined,
            }),
            relationship: () => ({ value: () => ({ canDm: canDm() }), activate: () => () => {} }),
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

  it('limits editing by original location while retaining reactions and recall', () => {
    TestBed.inject(SessionStore).user.set(testUser);
    menu['selection'].set({ ...selection(), own: true });
    mode.set(SpeakingMode.threadsOnly);
    expect(menu['canEdit']()).toBe(false);
    expect(menu['canThread']()).toBe(true);
    expect(menu['canReact']()).toBe(true);
    expect(menu['canRecall']()).toBe(true);
    mode.set(SpeakingMode.repliesOnly);
    expect(menu['canThread']()).toBe(false);
    setMessages([{ ...testMessage, replyRootId: encodeId('100') }]);
    expect(menu['canEdit']()).toBe(true);
    mode.set(SpeakingMode.readOnly);
    expect(menu['canEdit']()).toBe(false);
    expect(menu['canReact']()).toBe(true);
    expect(menu['canRecall']()).toBe(true);
    admin.set(true);
    expect(menu['canEdit']()).toBe(true);
  });

  it.each([
    [500, 200, 500, 208],
    [1275, 890, 918, 444],
    [5, 2, 12, 12],
  ])('places the desktop picker near (%s, %s) within the overlay', (x, y, left, top) => {
    const platforms = getPlatforms();
    const original = [...platforms];
    platforms.splice(0, platforms.length, 'desktop');
    try {
      const surface = fixture.nativeElement.querySelector('.menu-surface') as HTMLElement;
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 900));
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(350);
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(444);
      fixture.nativeElement
        .querySelector('.reactions button:last-child')
        .dispatchEvent(new MouseEvent('click', { detail: 1, clientX: x, clientY: y, bubbles: true }));
      fixture.detectChanges();
      const panel = fixture.nativeElement.querySelector('.emoji-panel') as HTMLElement;
      expect(panel.style.left).toBe(`${left}px`);
      expect(panel.style.top).toBe(`${top}px`);
      expect(panel.style.transform).toBe('none');
    } finally {
      platforms.splice(0, platforms.length, ...original);
    }
  });

  it.each(['ios', 'android'] as const)('keeps the picker centered on %s', (platform) => {
    const platforms = getPlatforms();
    const original = [...platforms];
    platforms.splice(0, platforms.length, platform);
    try {
      fixture.nativeElement
        .querySelector('.reactions button:last-child')
        .dispatchEvent(new MouseEvent('click', { detail: 1, clientX: 100, clientY: 200, bubbles: true }));
      fixture.detectChanges();
      const panel = fixture.nativeElement.querySelector('.emoji-panel') as HTMLElement;
      expect(panel.style.left).toBe('');
      expect(panel.style.top).toBe('');
      expect(panel.style.transform).toBe('');
    } finally {
      platforms.splice(0, platforms.length, ...original);
    }
  });

  function openQueued(
    message: MessageContent = {
      chatId: testChat.id,
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
    expect(labels()).toEqual(['复制', '编辑', '撤回']);
    expect(fixture.nativeElement.querySelector('.reactions.panel')).toBeNull();
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
      chatId: testChat.id,
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
    expect(labels()).toEqual(['复制', '编辑', '撤回']);
    expect(ensureDetails).not.toHaveBeenCalled();
    outbox.items.set([]);
    fixture.detectChanges();
    expect(menu['selection']()?.messageId).toBeUndefined();
    expect(menu['serverMessage']()).toBe(confirmed);
    expect(menu['message']()).toBe(confirmed);
    expect(labels()).toEqual(['回复', '话题', '复制', '转发', '编辑', '收藏', '链接', '撤回']);
    expect(ensureDetails).toHaveBeenCalledExactlyOnceWith(testChat.id);
    expect(conversation.ensure).toHaveBeenCalledOnce();
    await menu['choose'](MessageAction.Save);
    expect(savedMessages.save).toHaveBeenCalledExactlyOnceWith(confirmed);
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
    expect(labels()).toEqual(['复制', '编辑', '撤回']);
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
    expect(savedMessages.save).not.toHaveBeenCalled();
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

  it('offers selection only when its owner supports it and never edits forwarded text', async () => {
    fixture.componentRef.setInput('allowSelect', true);
    setMessages([
      {
        ...testMessage,
        sender: { ...testMessage.sender, uid: testUser.uid },
        forwardedFrom: {
          sender: testMessage.sender,
          originalChatId: testChat.id,
          originalMessageId: testMessage.id,
        },
      },
    ]);
    fixture.detectChanges();
    expect(labels()).toContain('多选');
    expect(labels()).toContain('转发');
    expect(labels()).not.toContain('编辑');
    const select = vi.fn();
    menu.select.subscribe(select);
    await menu['choose'](MessageAction.Select);
    expect(select).toHaveBeenCalledWith(messages()[0]);
  });

  it('shows member actions, then adds admin pin and recall actions in order', () => {
    expect(labels()).toEqual(['回复', '话题', '复制', '转发', '收藏', '链接']);
    admin.set(true);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '话题', '复制', '转发', '收藏', '链接', '置顶', '撤回']);
    pinned.set(true);
    fixture.detectChanges();
    expect(labels()).toContain('取消置顶');
  });

  it('lets a DM participant pin without group admin rights and drops the link action', () => {
    kind.set(GroupKind.dm);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '话题', '复制', '转发', '收藏', '置顶']);
    expect(menu['admin']()).toBe(false);
  });

  it('reduces a DM whose friendship ended to read-only actions', () => {
    kind.set(GroupKind.dm);
    canDm.set(false);
    setMessages([{ ...testMessage, reactions: [{ emoji: '👍', count: 1, reactedByMe: false }] }]);
    fixture.detectChanges();
    expect(labels()).toEqual(['复制', '转发', '收藏', '查看表态']);
  });

  it('leaves group actions unaffected by the DM relationship', () => {
    canDm.set(false);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '话题', '复制', '转发', '收藏', '链接']);
  });

  it('dismisses a reaction in a read-only DM without sending it', async () => {
    kind.set(GroupKind.dm);
    canDm.set(false);
    setMessages([{ ...testMessage, reactions: [{ emoji: '👍', count: 1, reactedByMe: true }] }]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.reactions button.selected') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(actions.toggleReaction).not.toHaveBeenCalled();
    expect(menu['notice']()).toBeUndefined();
    expect(menu['selection']()).toBeUndefined();
  });

  it('keeps topic, deleted and special-message actions within their supported scope', () => {
    fixture.componentRef.setInput('threadId', encodeId('100'));
    fixture.detectChanges();
    expect(labels()).not.toContain('话题');
    admin.set(true);
    setMessages([{ ...testMessage, messageType: MessageType.sticker }]);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '转发', '链接', '撤回']);
    expect(fixture.nativeElement.querySelector('.reactions.panel')).toBeNull();
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

  it('names the author when confirming the recall of another member’s message', async () => {
    const alert = () =>
      (fixture.nativeElement.querySelector('ion-alert') as HTMLElement & { message?: string }).message;
    await menu['choose'](MessageAction.Recall);
    fixture.detectChanges();
    expect(menu['confirmation']()?.action).toBe(MessageAction.Recall);
    expect(alert()).toBe('确定要撤回 测试用户 的这条消息吗？');
  });

  it('confirms the recall of an own message without naming anyone', async () => {
    const alert = () =>
      (fixture.nativeElement.querySelector('ion-alert') as HTMLElement & { message?: string }).message;
    menu.reset();
    setMessages([{ ...testMessage, sender: { ...testMessage.sender, uid: testUser.uid + 1 } }]);
    fixture.detectChanges();
    menu.open(selection());
    await menu['choose'](MessageAction.Recall);
    fixture.detectChanges();
    expect(menu['recallAuthor']()).toBeUndefined();
    expect(alert()).toBe('撤回后，其他成员将无法查看这条消息。');
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

  it('widens the preview when the sender row it adds does not fit the original bubble', () => {
    menu.reset();
    authorWidth = 358;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('avatar-slot') ? 44 : 300;
    });
    menu.open(selection());
    fixture.detectChanges();
    const preview = fixture.nativeElement.querySelector('.preview') as HTMLElement;
    // 358px complete author row + 22px bubble padding + 44px avatar column.
    expect(parseFloat(preview.style.width)).toBe(424);
  });

  it('includes the complete author row for a short bubble', () => {
    menu.reset();
    authorWidth = 186;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('avatar-slot') ? 44 : 300;
    });
    menu.open({ ...selection(), rect: new DOMRect(100, 200, 46, 70) });
    fixture.detectChanges();
    const preview = fixture.nativeElement.querySelector('.preview') as HTMLElement;
    expect(parseFloat(preview.style.width)).toBe(252);
  });

  it('rounds fractional author widths up so a subpixel deficit cannot produce an ellipsis', () => {
    menu.reset();
    authorWidth = 135.453125;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('avatar-slot') ? 44 : 300;
    });
    menu.open({ ...selection(), rect: new DOMRect(100, 200, 46.25, 70) });
    fixture.detectChanges();
    const preview = fixture.nativeElement.querySelector('.preview') as HTMLElement;
    expect(parseFloat(preview.style.width)).toBe(202);
    expect(preview.querySelector<HTMLElement>('.sender')!.style.width).toBe('');
  });

  it('keeps the right edge of an own bubble aligned when its anchored preview widens', () => {
    authorWidth = 358;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('avatar-slot') ? 44 : 276;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(2000);
    const rect = new DOMRect(400, 200, 180, 900);
    menu['selection'].set({ ...selection(), rect, own: true });
    fixture.detectChanges();
    TestBed.tick();
    const stack = fixture.nativeElement.querySelector('.menu-stack') as HTMLElement;
    const preview = fixture.nativeElement.querySelector('.preview') as HTMLElement;
    expect(stack.classList.contains('anchored')).toBe(true);
    expect(parseFloat(preview.style.width)).toBe(424);
    const bubbleRight =
      parseFloat(stack.style.left) + parseFloat(preview.style.left) + parseFloat(preview.style.width) - 44;
    expect(bubbleRight).toBe(rect.right);
  });

  it('keeps the preview avatar on screen when the chat omits avatar details', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('avatar-slot') ? 44 : 276;
    });
    // A DM without avatar details leaves the bubble 15px from the edge; the overlay adds a 44px avatar column.
    menu['selection'].set({ ...selection(), rect: new DOMRect(15, 200, 180, 70), own: false });
    fixture.detectChanges();
    TestBed.tick();
    const stack = fixture.nativeElement.querySelector('.menu-stack') as HTMLElement;
    const preview = fixture.nativeElement.querySelector('.preview') as HTMLElement;
    expect(stack.classList.contains('anchored')).toBe(false);
    expect(parseFloat(stack.style.left) + parseFloat(preview.style.left)).toBeGreaterThanOrEqual(12);
  });

  it('keeps the anchored preview avatar on screen when the chat omits avatar details', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('avatar-slot') ? 44 : 276;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(2000);
    menu['selection'].set({ ...selection(), rect: new DOMRect(15, 200, 180, 70), own: false });
    fixture.detectChanges();
    TestBed.tick();
    const stack = fixture.nativeElement.querySelector('.menu-stack') as HTMLElement;
    const preview = fixture.nativeElement.querySelector('.preview') as HTMLElement;
    expect(stack.classList.contains('anchored')).toBe(true);
    expect(parseFloat(stack.style.left) + parseFloat(preview.style.left)).toBeGreaterThanOrEqual(12);
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
    savedMessages.save.mockReturnValueOnce(
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
    expect(savedMessages.save).toHaveBeenCalledOnce();
    menu.reset();
    finish();
    await saving;
    expect(menu.busy()).toBe(false);
    expect(menu['notice']()).toBeUndefined();
    expect(menu['confirmation']()).toBeUndefined();
  });

  it('copies the same lossless short message link as the old application', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await menu['choose'](MessageAction.Link);
    expect(writeText).toHaveBeenCalledWith(new URL('/m/ACAAAAAAAAEAIAAAAAAACw', document.baseURI).href);
  });

  it('starts a clipboard write synchronously before dismissal completes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const copying = menu['choose'](MessageAction.Copy);
    expect(writeText).toHaveBeenCalledWith(testMessage.message);
    await copying;
    expect(menu['notice']()).toBe(MessageNotice.Copied);
  });
  it('uses the legacy sticker actions and favorites the sticker instead of saving the message', async () => {
    admin.set(true);
    pinned.set(true);
    const sticker = {
      id: encodeId('123'),
      emoji: '🙂',
      name: '表情',
      createdAt: testMessage.createdAt,
      isFavorited: false,
      media: { id: encodeId('124'), url: '/sticker.png', contentType: 'image/png', width: 100, height: 100, size: 20 },
    };
    setMessages([
      {
        ...testMessage,
        messageType: MessageType.sticker,
        sticker,
        reactions: [{ emoji: '👍', count: 1, reactedByMe: false }],
      },
    ]);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '转发', '收藏表情', '链接', '撤回']);
    expect(fixture.nativeElement.querySelector('.reactions.panel')).toBeNull();
    await menu['choose'](MessageAction.FavoriteSticker);
    expect(favoriteStickers.set).toHaveBeenCalledWith(sticker.id, true);
    expect(savedMessages.save).not.toHaveBeenCalled();
  });

  it('reverses the saved state of the selected message', async () => {
    savedIds.set(new Set([testMessage.id]));
    menu.reset();
    menu.open(selection());
    fixture.detectChanges();
    expect(labels()).toContain('取消收藏');
    await menu['choose'](MessageAction.Save);
    expect(savedMessages.unsave).toHaveBeenCalledWith(testMessage);
    expect(savedMessages.save).not.toHaveBeenCalled();
    expect(menu['notice']()).toBe(MessageNotice.Unsaved);
  });

  it('accepts save while loading and preserves the clicked intent when the read finds it already saved', async () => {
    let finishLoading!: () => void;
    const loading = new Promise<void>((resolve) => (finishLoading = resolve));
    savedLoading.set(true);
    savedMessages.ensure.mockReturnValueOnce(loading);
    fixture.detectChanges();
    const button = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.actions button'),
    ].find((button) => button.textContent?.trim() === '收藏')!;
    expect(button.disabled).toBe(false);
    const saving = menu['choose'](MessageAction.Save);
    await vi.waitFor(() => expect(menu.busy()).toBe(true));
    expect(savedMessages.save).not.toHaveBeenCalled();
    savedIds.set(new Set([testMessage.id]));
    finishLoading();
    await saving;
    expect(savedMessages.save).toHaveBeenCalledWith(testMessage);
    expect(savedMessages.unsave).not.toHaveBeenCalled();
    expect(menu['notice']()).toBe(MessageNotice.Saved);
  });

  it('reports a failed saved-state read without writing and allows retry', async () => {
    savedMessages.ensure.mockRejectedValueOnce(new Error('offline'));
    await menu['choose'](MessageAction.Save);
    expect(savedMessages.save).not.toHaveBeenCalled();
    expect(menu['notice']()).toBe(MessageNotice.Failed);
    expect(menu.busy()).toBe(false);
    menu.open(selection());
    await menu['choose'](MessageAction.Save);
    expect(savedMessages.save).toHaveBeenCalledWith(testMessage);
  });

  it('reverses the favorite state of the selected sticker', async () => {
    const sticker = {
      id: encodeId('123'),
      emoji: '🙂',
      name: '表情',
      createdAt: testMessage.createdAt,
      isFavorited: true,
      media: { id: encodeId('124'), url: '/sticker.png', contentType: 'image/png', width: 100, height: 100, size: 20 },
    };
    favoriteIds.set(new Set([sticker.id]));
    setMessages([{ ...testMessage, messageType: MessageType.sticker, sticker }]);
    menu.reset();
    menu.open(selection());
    fixture.detectChanges();
    expect(labels()).toContain('取消收藏表情');
    await menu['choose'](MessageAction.FavoriteSticker);
    expect(favoriteStickers.set).toHaveBeenCalledWith(sticker.id, false);
    expect(menu['notice']()).toBe(MessageNotice.Unsaved);
  });
});

describe('pageSlots', () => {
  function layout(count: number, page: number) {
    const list: MenuSlot[] = Array.from({ length: count }, () => ({
      kind: 'action',
      action: MessageAction.Reply,
      disabled: false,
      destructive: false,
    }));
    return pageSlots(list, page).map((slot) => (slot.kind === 'paging' ? slot.direction : list.indexOf(slot)));
  }

  it('keeps two rows of five without paging', () => {
    expect(layout(10, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('pages from the second row once a third row exists', () => {
    expect(layout(14, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 'down']);
    expect(layout(14, 1)).toEqual([5, 6, 7, 8, 'up', 9, 10, 11, 12, 13]);
  });

  it('keeps two rows visible for a fourth row and reaches eighteen actions', () => {
    expect(layout(18, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 'down']);
    expect(layout(18, 1)).toEqual([9, 10, 11, 12, 'up', 13, 14, 15, 16, 17]);
  });

  it('shows the remaining actions on the last page', () => {
    expect(layout(11, 1)).toEqual([5, 6, 7, 8, 'up', 9, 10]);
    expect(layout(15, 1)).toEqual([9, 10, 11, 12, 'up', 13, 14]);
  });
});
