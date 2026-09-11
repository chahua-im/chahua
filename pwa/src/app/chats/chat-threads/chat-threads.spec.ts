import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { jsonInterceptor } from '../../api/json.interceptor';
import { encodeId } from '../../api/snowflake-id';
import { testChat, wireChat, wireMessage } from '../../api/testing';
import { ChatThreads } from './chat-threads';

const path = `/_api/chats/${wireChat.id}/messages`;
const topic = { ...wireMessage, threadInfo: { replyCount: 4 } };

describe('ChatThreads', () => {
  let http: HttpTestingController;
  const modals = { getTop: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(true) };
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        provideRouter([]),
        { provide: ModalController, useValue: modals },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  function open() {
    const fixture = TestBed.createComponent(ChatThreads);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    return fixture;
  }

  it('extracts topics in descending root order, including unsubscribed and recalled roots', async () => {
    const fixture = open();
    const request = http.expectOne((req) => req.url === path);
    expect(request.request.params.get('max')).toBe('50');
    request.flush({
      messages: [
        { ...wireMessage, id: '100' },
        { ...topic, id: '101', isDeleted: true, message: undefined },
        { ...topic, id: '102', message: '当前话题' },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['items']().map((root) => root.id)).toEqual([encodeId('102'), encodeId('101')]);
    const rows = fixture.nativeElement.querySelectorAll('app-chat-list-item');
    expect(rows[0].textContent).toContain('当前话题');
    expect(rows[0].textContent).toContain('4 条回复');
    expect(rows[1].textContent).toContain('话题');
    expect(rows[1].textContent).not.toContain('消息已删除');
    http.expectNone((req) => req.url.includes('/threads') || req.url.includes('/subscribe'));
  });

  it('retains the message cursor without filling a tall sidebar with automatic history scans', async () => {
    const fixture = open();
    const scroll = document.createElement('div');
    Object.defineProperties(scroll, { clientHeight: { value: 900 }, scrollHeight: { value: 900 } });
    const content = document.createElement('ion-content');
    content.getScrollElement = () => Promise.resolve(scroll);
    vi.spyOn(fixture.nativeElement, 'closest').mockReturnValue(content);
    http.expectOne((req) => req.url === path).flush({ messages: [{ ...wireMessage }], olderCursor: '100' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('暂无近期话题');
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).not.toBeNull();
    http.expectNone((req) => req.url === path);
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll ion-button')).toBeNull();
    const complete = vi.fn().mockResolvedValue(undefined);
    fixture.nativeElement.querySelector('ion-infinite-scroll').complete = complete;
    fixture.nativeElement.querySelector('ion-infinite-scroll').dispatchEvent(new CustomEvent('ionInfinite'));
    const request = http.expectOne((req) => req.url === path);
    expect(request.request.params.get('before')).toBe('100');
    request.flush({ messages: [{ ...topic, id: '99' }] });
    await fixture.whenStable();
    expect(complete).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['items']()).toHaveLength(1);
    expect(fixture.componentInstance['cursor']()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).toBeNull();
  });

  it('keeps loaded topics and the cursor after a failed continuation', async () => {
    const fixture = open();
    http.expectOne((req) => req.url === path).flush({ messages: [{ ...topic }], olderCursor: '100' });
    await fixture.whenStable();
    const component = fixture.componentInstance;
    const next = component['load'](true);
    http.expectOne((req) => req.url === path).flush({}, { status: 503, statusText: 'Unavailable' });
    await next;
    expect(component['items']()).toHaveLength(1);
    expect(component['cursor']()).toBe(encodeId('100'));
    expect(component['error']()).toBe(true);
    const retry = component['load'](true);
    http.expectOne((req) => req.url === path).flush({ messages: [{ ...topic, id: '99' }] });
    await retry;
    expect(component['items']()).toHaveLength(2);
    expect(component['error']()).toBe(false);
  });

  it('ignores the previous chat response and cancels a hidden tab request', async () => {
    const fixture = open();
    const previous = http.expectOne((req) => req.url === path);
    fixture.componentRef.setInput('chatId', encodeId('200'));
    fixture.detectChanges();
    http.expectOne((req) => req.url === '/_api/chats/200/messages').flush({ messages: [{ ...topic, chatId: '200' }] });
    previous.flush({ messages: [{ ...topic }] });
    await fixture.whenStable();
    expect(fixture.componentInstance['items']()[0].chatId).toBe(encodeId('200'));
    const request = fixture.componentInstance['load']();
    const pending = http.expectOne((req) => req.url === '/_api/chats/200/messages');
    fixture.destroy();
    await request;
    expect(pending.cancelled).toBe(true);
  });

  it('opens the selected topic after dismissing the information modal', async () => {
    const fixture = open();
    http.expectOne((req) => req.url === path).flush({ messages: [{ ...topic }] });
    await fixture.whenStable();
    modals.getTop.mockResolvedValueOnce({});
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await fixture.componentInstance['open'](fixture.componentInstance['items']()[0]);
    expect(modals.dismiss).toHaveBeenCalledWith(undefined, 'navigate');
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id, 'thread', topic.id]);
  });
});
