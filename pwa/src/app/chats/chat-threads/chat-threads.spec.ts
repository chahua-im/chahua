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

const path = `/_api/chats/${wireChat.id}/threads`;
const messagePath = `/_api/chats/${wireChat.id}/messages`;
let topic = { ...wireMessage, threadInfo: { replyCount: 4 } };

describe('ChatThreads', () => {
  let http: HttpTestingController;
  const modals = { getTop: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(true) };
  beforeEach(() => {
    topic = { ...wireMessage, threadInfo: { replyCount: 4 } };
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

  it('renders thread roots in backend newest order, including recalled roots', async () => {
    const fixture = open();
    const request = http.expectOne((req) => req.url === path);
    expect(request.request.params.get('limit')).toBe('50');
    expect(request.request.params.get('order')).toBe('newest');
    expect(request.request.params.get('cursor')).toBeNull();
    request.flush({
      threads: [
        { ...topic, id: '102', message: '当前话题' },
        { ...topic, id: '101', isDeleted: true, message: undefined },
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
    http.expectNone((req) => req.url === messagePath);
  });

  it('uses the returned cursor for continuation and removes infinite scroll at null', async () => {
    const fixture = open();
    http.expectOne((req) => req.url === path).flush({ threads: [{ ...topic }], nextCursor: '100' });
    await fixture.whenStable();
    fixture.detectChanges();
    const infinite = fixture.nativeElement.querySelector('ion-infinite-scroll');
    const complete = vi.fn().mockResolvedValue(undefined);
    infinite.complete = complete;
    infinite.dispatchEvent(new CustomEvent('ionInfinite'));
    const request = http.expectOne((req) => req.url === path);
    expect(request.request.params.get('cursor')).toBe('100');
    request.flush({ threads: [{ ...topic, id: '99' }], nextCursor: null });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(complete).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['items']()).toHaveLength(2);
    expect(fixture.componentInstance['cursor']()).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).toBeNull();
  });

  it('keeps loaded topics and the cursor after a failed continuation', async () => {
    const fixture = open();
    http.expectOne((req) => req.url === path).flush({ threads: [{ ...topic }], nextCursor: '100' });
    await fixture.whenStable();
    const component = fixture.componentInstance;
    const next = component['load'](true);
    const failed = http.expectOne((req) => req.url === path);
    expect(failed.request.params.get('cursor')).toBe('100');
    failed.flush({}, { status: 503, statusText: 'Unavailable' });
    await next;
    expect(component['items']()).toHaveLength(1);
    expect(component['cursor']()).toBe(encodeId('100'));
    expect(component['error']()).toBe(true);
    const retry = component['load'](true);
    const retried = http.expectOne((req) => req.url === path);
    expect(retried.request.params.get('cursor')).toBe('100');
    retried.flush({ threads: [{ ...topic, id: '99' }] });
    await retry;
    expect(component['items']()).toHaveLength(2);
    expect(component['error']()).toBe(false);
  });

  it('keeps known rows during refresh and retries the first page rather than the retained cursor', async () => {
    const fixture = open();
    http.expectOne((req) => req.url === path).flush({ threads: [topic], nextCursor: '100' });
    await fixture.whenStable();
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('app-chat-list-item');
    const refreshing = fixture.componentInstance['load']();
    const refresh = http.expectOne((req) => req.url === path);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-chat-list-item')).toBe(row);
    expect(fixture.nativeElement.querySelector('.page-loading')).toBeNull();
    refresh.flush({}, { status: 503, statusText: 'Unavailable' });
    await refreshing;
    fixture.detectChanges();
    fixture.nativeElement.querySelector('app-load-error ion-button').click();
    const retry = http.expectOne((req) => req.url === path);
    expect(retry.request.params.has('cursor')).toBe(false);
    retry.flush({ threads: [{ ...topic, message: 'Updated root' }], nextCursor: null });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-chat-list-item')).toBe(row);
    expect(row.textContent).toContain('Updated root');
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).toBeNull();
  });

  it('clears revoked content and rejects an older successful response', async () => {
    const fixture = open();
    http.expectOne((req) => req.url === path).flush({ threads: [topic], nextCursor: '100' });
    await fixture.whenStable();
    const olderLoad = fixture.componentInstance['load']();
    const older = http.expectOne((req) => req.url === path);
    const currentLoad = fixture.componentInstance['load']();
    http.expectOne((req) => req.url === path).flush({}, { status: 403, statusText: 'Forbidden' });
    await currentLoad;
    older.flush({ threads: [topic], nextCursor: '100' });
    await olderLoad;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-chat-list-item')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-load-error')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-load-error ion-button')).toBeNull();
  });

  it('cancels prior chat reads and ignores them after the scope changes or is destroyed', async () => {
    const fixture = open();
    const previous = http.expectOne((req) => req.url === path);
    fixture.componentRef.setInput('chatId', encodeId('200'));
    fixture.detectChanges();
    expect(previous.cancelled).toBe(true);
    http.expectOne((req) => req.url === '/_api/chats/200/threads').flush({ threads: [{ ...topic, chatId: '200' }] });
    await fixture.whenStable();
    expect(fixture.componentInstance['items']()[0].chatId).toBe(encodeId('200'));
    const request = fixture.componentInstance['load']();
    const pending = http.expectOne((req) => req.url === '/_api/chats/200/threads');
    fixture.destroy();
    await request;
    expect(pending.cancelled).toBe(true);
  });

  it('opens the selected topic after dismissing the information modal', async () => {
    const fixture = open();
    http.expectOne((req) => req.url === path).flush({ threads: [{ ...topic }] });
    await fixture.whenStable();
    modals.getTop.mockResolvedValueOnce({});
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await fixture.componentInstance['open'](fixture.componentInstance['items']()[0]);
    expect(modals.dismiss).toHaveBeenCalledWith(undefined, 'navigate');
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id, 'thread', wireMessage.id]);
  });
});
