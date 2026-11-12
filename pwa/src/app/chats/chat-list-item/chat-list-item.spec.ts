import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { IonButton, IonItemOption, IonItemSliding, IonPopover, getPlatforms } from '@ionic/angular';
import { vi } from 'vitest';

import { archiveOutline } from 'ionicons/icons';
import { MessageDelivery } from '../../messages/message-delivery';
import { ChatListItem } from './chat-list-item';

describe('ChatListItem', () => {
  let originalPlatforms: ReturnType<typeof getPlatforms>;
  let component: ChatListItem;
  let fixture: ComponentFixture<ChatListItem>;

  const entry = {
    title: '测试群',
    subtitle: '最新消息',
    link: ['/chats/chat', 'chat-1'],
    time: '2026-09-05T12:00:00Z',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const platforms = getPlatforms();
    originalPlatforms = [...platforms];
    platforms.splice(0, platforms.length, 'ios');
    vi.spyOn(IonItemSliding.prototype, 'close').mockResolvedValue();
    vi.spyOn(IonPopover.prototype, 'isOpen', 'set').mockImplementation(() => {});
    await TestBed.configureTestingModule({
      imports: [ChatListItem],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatListItem);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('entry', entry);
    fixture.detectChanges();
  });

  afterEach(() => {
    getPlatforms().splice(0, getPlatforms().length, ...originalPlatforms);
    vi.restoreAllMocks();
  });

  it('renders an archive shortcut without conversation data or conversation actions', async () => {
    fixture.componentRef.setInput('entry', {
      title: '已归档',
      subtitle: '查看已归档的会话',
      icon: archiveOutline,
      link: ['/chats/messages/archived'],
      unreadCount: 37,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-item').getAttribute('href')).toBe('/chats/messages/archived');
    expect(fixture.nativeElement.querySelector('ion-label h3').textContent.trim()).toBe('已归档');
    expect(fixture.nativeElement.querySelector('ion-label p').textContent).toContain('查看已归档的会话');
    expect(fixture.nativeElement.querySelector('ion-badge').textContent.trim()).toBe('37');
    expect(fixture.nativeElement.querySelector('ion-avatar.icon-avatar ion-icon')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('ion-button')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-item-options')).toBeNull();
  });

  it('keeps delivery before the timestamp and outside the clipped message preview', () => {
    fixture.componentRef.setInput('entry', { ...entry, delivery: MessageDelivery.Sent, read: true });
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('app-message-status');
    expect(status).not.toBeNull();
    expect(status.querySelector('ion-icon')).not.toBeNull();
    expect(status.closest('.meta')).not.toBeNull();
    expect(status.nextElementSibling.textContent.trim()).not.toBe('');
    expect(fixture.nativeElement.querySelector('ion-label app-message-status')).toBeNull();
  });

  it('renders a mention badge without a numeric unread count', async () => {
    fixture.componentRef.setInput('entry', {
      title: '测试群',
      subtitle: '最新消息',
      link: ['/chats/chat', 'chat-1'],
      unreadMentions: 1,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    const badge = fixture.nativeElement.querySelector('ion-badge.mention-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent.trim()).toBe('@');
  });

  it('keeps muted mention badges gray and restores their normal color after unmuting', async () => {
    fixture.componentRef.setInput('entry', { ...entry, unreadMentions: 3, muted: true });
    await fixture.whenStable();
    const badge = fixture.nativeElement.querySelector('ion-badge.mention-badge');
    expect(badge.textContent.trim()).toBe('@');
    expect(badge.color).toBe('medium');
    fixture.componentRef.setInput('entry', { ...entry, unreadMentions: 3, muted: false });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-badge.mention-badge')).toBe(badge);
    expect(badge.color).toBe('primary');
  });

  it('renders a reaction badge without a numeric unread count', async () => {
    fixture.componentRef.setInput('entry', {
      title: '测试群',
      subtitle: '最新消息',
      link: ['/chats/chat', 'chat-1'],
      unreadReactions: 2,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    const badges = fixture.nativeElement.querySelectorAll('ion-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].classList.contains('reaction-badge')).toBe(true);
    expect(badges[0].querySelector('ion-icon')).not.toBeNull();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
    expect(fixture.nativeElement.querySelector('ion-item').getAttribute('href')).toBe('/chats/chat/chat-1');
  });

  it('renders a request without a navigation link or conversation actions', async () => {
    fixture.componentRef.setInput('entry', { title: '小花', subtitle: '好友请求' });
    fixture.detectChanges();
    await fixture.whenStable();
    const item = fixture.nativeElement.querySelector('ion-item');
    expect(item.getAttribute('href')).toBeNull();
    expect(item.classList.contains('selected')).toBe(false);
    expect(fixture.nativeElement.querySelector('ion-button')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-item-options')).toBeNull();
  });

  function options(side: 'start' | 'end') {
    return fixture.debugElement
      .queryAll(By.directive(IonItemOption))
      .filter((option) => option.nativeElement.parentElement.getAttribute('side') === side);
  }

  function desktopActions(platforms: ReturnType<typeof getPlatforms> = ['desktop']) {
    fixture.destroy();
    getPlatforms().splice(0, getPlatforms().length, ...platforms);
    fixture = TestBed.createComponent(ChatListItem);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('entry', entry);
    const read = { label: '标为已读', icon: archiveOutline, run: vi.fn() };
    const archive = { label: '归档', icon: archiveOutline, run: vi.fn() };
    fixture.componentRef.setInput('startActions', [read]);
    fixture.componentRef.setInput('endActions', [archive]);
    fixture.detectChanges();
    return { read, archive };
  }

  it.each<ReturnType<typeof getPlatforms>>([['desktop'], ['mobile', 'mobileweb']])(
    'offers mouse actions on desktop systems with Ionic platforms %s',
    (...platforms) => {
      desktopActions(platforms);
      expect(fixture.debugElement.query(By.directive(IonItemSliding)).componentInstance.disabled).toBe(true);
      expect(fixture.nativeElement.querySelector('ion-item-options')).toBeNull();
      expect(fixture.nativeElement.querySelector('ion-button')).toBeNull();
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      fixture.nativeElement.querySelector('.chat-entry').dispatchEvent(event);
      expect(component['menuEvent']()).toBe(event);
    },
  );

  it('opens from right click without selecting or navigating, and clears on dismissal', () => {
    desktopActions();
    fixture.componentRef.setInput('button', true);
    fixture.detectChanges();
    const selected = vi.fn();
    component.selected.subscribe(selected);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 45, clientY: 70 });
    fixture.nativeElement.querySelector('.chat-entry').dispatchEvent(event);
    fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
    expect(selected).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.chat-entry').classList.contains('menu-open')).toBe(true);
    const menu = fixture.debugElement.query(By.directive(IonPopover));
    expect(menu.componentInstance.event).toBe(event);
    expect(menu.componentInstance.reference).toBe('event');
    menu.triggerEventHandler('didDismiss', {});
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-popover')).toBeNull();
    expect(fixture.nativeElement.querySelector('.chat-entry').classList.contains('menu-open')).toBe(false);
  });

  it('dismisses the menu before running an action and blocks repeat actions until failure settles', async () => {
    const { archive } = desktopActions();
    let reject!: (error: Error) => void;
    archive.run.mockImplementation(() => new Promise<void>((_, fail) => (reject = fail)));
    component['openMenu'](new MouseEvent('contextmenu', { cancelable: true }));
    fixture.detectChanges();
    const menu = fixture.debugElement.query(By.directive(IonPopover)).componentInstance as IonPopover;
    const dismiss = vi.spyOn(menu, 'dismiss').mockImplementation(async () => {
      expect(archive.run).not.toHaveBeenCalled();
      component['menuEvent'].set(undefined);
      return true;
    });
    const pending = component['perform'](archive, new Event('click'));
    await vi.waitFor(() => expect(archive.run).toHaveBeenCalledOnce());
    fixture.detectChanges();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('ion-spinner[slot="end"]')).not.toBeNull();
    component['openMenu'](new MouseEvent('contextmenu'));
    await component['perform'](archive, new Event('click'));
    expect(component['menuEvent']()).toBeUndefined();
    expect(archive.run).toHaveBeenCalledOnce();
    reject(new Error('offline'));
    await pending;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-spinner[slot="end"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-label[color="danger"]')).not.toBeNull();
  });

  it('preserves mobile swipes and native context menus, and excludes always-visible actions', () => {
    fixture.componentRef.setInput('endActions', [{ label: '归档', icon: archiveOutline, run: vi.fn() }]);
    fixture.detectChanges();
    expect(options('end')).toHaveLength(1);
    const mobileEvent = new MouseEvent('contextmenu', { cancelable: true });
    component['openMenu'](mobileEvent);
    expect(mobileEvent.defaultPrevented).toBe(false);
    desktopActions();
    fixture.componentRef.setInput('actionsAlwaysVisible', true);
    fixture.detectChanges();
    const requestEvent = new MouseEvent('contextmenu', { cancelable: true });
    component['openMenu'](requestEvent);
    expect(requestEvent.defaultPrevented).toBe(false);
  });

  it('supports multiple actions on both sides and hides the whole meta column when always visible', async () => {
    const run = vi.fn();
    const left = [
      { label: '左一', icon: archiveOutline, run },
      { label: '左二', icon: archiveOutline, run },
    ];
    const right = [
      { label: '右一', icon: archiveOutline, run },
      { label: '右二', icon: archiveOutline, run },
    ];
    fixture.componentRef.setInput('startActions', left);
    fixture.componentRef.setInput('endActions', right);
    fixture.detectChanges();
    expect(options('start')).toHaveLength(2);
    expect(options('end')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.meta')).not.toBeNull();
    fixture.componentRef.setInput('actionsAlwaysVisible', true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-item-options')).toBeNull();
    expect(fixture.nativeElement.querySelector('.meta')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('ion-buttons[slot="start"] ion-button')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('ion-buttons[slot="end"] ion-button')).toHaveLength(2);
    expect(fixture.debugElement.query(By.directive(IonItemSliding)).componentInstance.disabled).toBe(true);
    const event = new Event('click', { cancelable: true });
    const stop = vi.spyOn(event, 'stopPropagation');
    fixture.debugElement.queryAll(By.directive(IonButton))[0].triggerEventHandler('click', event);
    await fixture.whenStable();
    expect(run).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });
  it('shows only the pending request action and restores controls after failure', async () => {
    let reject!: (error: Error) => void;
    const run = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const action = { label: '接受', icon: archiveOutline, run };
    fixture.componentRef.setInput('endActions', [action, { label: '拒绝', icon: archiveOutline, run: vi.fn() }]);
    fixture.componentRef.setInput('actionsAlwaysVisible', true);
    fixture.detectChanges();
    const pending = component['perform'](action, new Event('click'));
    await Promise.resolve();
    fixture.detectChanges();
    const buttons = fixture.debugElement.queryAll(By.directive(IonButton));
    expect(buttons[0].nativeElement.querySelector('ion-spinner')).not.toBeNull();
    expect(buttons[1].nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(buttons.every((button) => button.componentInstance.disabled)).toBe(true);
    await component['perform'](action, new Event('click'));
    expect(run).toHaveBeenCalledOnce();
    reject(new Error('offline'));
    await pending;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(buttons.every((button) => !button.componentInstance.disabled)).toBe(true);
    expect(fixture.nativeElement.querySelector('ion-label[color="danger"]')).not.toBeNull();
  });
});
