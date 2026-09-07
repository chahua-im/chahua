import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { IonButton, IonItemOption, IonItemSliding } from '@ionic/angular';
import { vi } from 'vitest';

import { archiveOutline } from 'ionicons/icons';
import { ChatListItem } from './chat-list-item';

describe('ChatListItem', () => {
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
    vi.spyOn(IonItemSliding.prototype, 'close').mockResolvedValue();
    await TestBed.configureTestingModule({
      imports: [ChatListItem],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatListItem);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('entry', entry);
    fixture.detectChanges();
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders an archive shortcut without conversation data or conversation actions', async () => {
    fixture.componentRef.setInput('entry', {
      title: '已归档',
      subtitle: '查看已归档的对话',
      icon: archiveOutline,
      link: ['/chats/messages/archived'],
      unreadCount: 37,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-item').getAttribute('href')).toBe('/chats/messages/archived');
    expect(fixture.nativeElement.querySelector('ion-label h3').textContent.trim()).toBe('已归档');
    expect(fixture.nativeElement.querySelector('ion-label p').textContent).toContain('查看已归档的对话');
    expect(fixture.nativeElement.querySelector('ion-badge').textContent.trim()).toBe('37');
    expect(fixture.nativeElement.querySelector('ion-avatar.icon-avatar ion-icon')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('ion-button')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-item-options')).toBeNull();
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
