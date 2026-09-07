import { By } from '@angular/platform-browser';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { IonModal } from '@ionic/angular';
import { vi } from 'vitest';
import { GroupRole, MessageType } from '../../../generated/models';
import { testChat, testMessage, testUser } from '../../api/testing';
import { encodeId } from '../../api/snowflake-id';
import { ChatStore } from '../../chats/chat-store';
import { ConversationStore } from '../../conversations/conversation-store';
import { MessageActions } from '../../conversations/message-actions';
import { MessageNotice } from '../../conversations/message-notice';
import { SessionStore } from '../../session/session-store';
import { Message } from '../message/message';
import { MessageAction, MessageMenu } from './message-menu';

describe('MessageMenu', () => {
  let fixture: ComponentFixture<MessageMenu>;
  let menu: MessageMenu;
  const messages = signal([testMessage]);
  const admin = signal(false);
  const pinned = signal(false);
  const conversation = {
    items: messages,
    pinsLoading: signal(false),
    pinFor: () => (pinned() ? { message: messages()[0] } : undefined),
    ensurePins: vi.fn().mockResolvedValue(undefined),
    setPinned: vi.fn().mockResolvedValue(undefined),
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
    first: true,
    last: true,
    own: false,
  });
  const labels = () =>
    [...fixture.nativeElement.querySelectorAll('.actions button')].map((button: Element) => button.textContent?.trim());

  beforeEach(async () => {
    vi.clearAllMocks();
    messages.set([testMessage]);
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
        provideRouter([]),
        { provide: ConversationStore, useValue: conversation },
        {
          provide: ChatStore,
          useValue: {
            get: () => ({ myRole: admin() ? GroupRole.admin : GroupRole.member }),
            ensureDetails: vi.fn().mockResolvedValue(undefined),
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
    messages.set([{ ...testMessage, messageType: MessageType.sticker }]);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '链接', '撤回']);
    expect(fixture.nativeElement.querySelector('.reactions')).toBeNull();
    messages.set([{ ...testMessage, messageType: MessageType.invite }]);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '置顶', '撤回']);
    messages.set([{ ...testMessage, isDeleted: true }]);
    fixture.detectChanges();
    expect(labels()).toEqual(['回复', '链接']);
  });

  it('toggles the selected reaction and delegates replying to its page', async () => {
    messages.set([{ ...testMessage, reactions: [{ emoji: '👍', count: 1, reactedByMe: true }] }]);
    fixture.detectChanges();
    const reply = vi.fn();
    menu.reply.subscribe(reply);
    const selected = fixture.nativeElement.querySelector('.reactions button[aria-pressed="true"]');
    expect(selected.textContent.trim()).toBe('👍');
    selected.click();
    expect(actions.toggleReaction).toHaveBeenCalledWith(messages()[0], '👍');
    await fixture.whenStable();
    menu.open(selection());
    await menu['choose'](MessageAction.Reply);
    expect(reply).toHaveBeenCalledWith(messages()[0]);
  });

  it('allows an admin to remove a deleted pin but never offers it to members', () => {
    messages.set([{ ...testMessage, isDeleted: true }]);
    pinned.set(true);
    fixture.detectChanges();
    expect(labels()).not.toContain('取消置顶');
    admin.set(true);
    fixture.detectChanges();
    expect(labels()).toContain('取消置顶');
  });

  it('keeps the menu inside a narrow viewport and dismisses only backdrop clicks', async () => {
    menu['selection'].set({ ...selection(), rect: new DOMRect(-50, -100, 1500, 70), own: true });
    fixture.detectChanges();
    TestBed.tick();
    const position = menu['position']();
    expect(position.left).toBeGreaterThanOrEqual(12);
    expect(position.top).toBeGreaterThanOrEqual(12);
    expect(position.width).toBeLessThanOrEqual(window.innerWidth - 24);
    fixture.nativeElement.querySelector('.preview').click();
    expect(menu['selection']()).toBeDefined();
    fixture.nativeElement.querySelector('.menu-surface').click();
    await fixture.whenStable();
    expect(menu['selection']()).toBeUndefined();
  });

  it('passes avatar preferences to its message preview', () => {
    fixture.componentRef.setInput('showAllAvatars', true);
    fixture.detectChanges();
    const preview = fixture.debugElement.query(By.directive(Message)).componentInstance as Message;
    expect(preview.showAllAvatars()).toBe(true);
    expect(preview.preview()).toBe(true);
  });

  it('runs only the confirmed pin action and retains its intended state', async () => {
    admin.set(true);
    await menu['choose'](MessageAction.Pin);
    expect(conversation.setPinned).not.toHaveBeenCalled();
    pinned.set(true);
    await menu['confirm'](new CustomEvent('didDismiss', { detail: { role: 'confirm' } }));
    expect(conversation.setPinned).toHaveBeenCalledWith(testMessage, true);
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
