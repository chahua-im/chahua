import { provideHttpClient, type HttpRequest, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import type { User } from '../../../generated/models';
import { jsonInterceptor } from '../../api/json.interceptor';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { testChat, testMessage, wireChat } from '../../api/testing';
import { ThreadParticipants } from './thread-participants';

const first: User = { uid: 1, name: '甲', gender: 0 };
const second: User = { uid: 2, name: '乙', gender: 0 };
const third: User = { uid: 3, name: '丙', gender: 0 };

function participantRequest(chatId = wireChat.id, rootId = decodeId(testMessage.id)) {
  return (request: HttpRequest<unknown>) =>
    request.url === `/_api/chats/${chatId}/threads/${rootId}/participants` && request.params.get('limit') === '100';
}

describe('ThreadParticipants', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        provideRouter([]),
        { provide: ModalController, useValue: {} },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function open() {
    const fixture = TestBed.createComponent(ThreadParticipants);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('rootId', testMessage.id);
    fixture.detectChanges();
    return fixture;
  }

  it('loads the authoritative roster in UID pages and removes paging at the final cursor', async () => {
    const fixture = open();
    expect(fixture.nativeElement.querySelector('.page-loading')).not.toBeNull();
    const initial = http.expectOne(participantRequest());
    expect(initial.request.params.get('cursor')).toBeNull();
    initial.flush({ participants: [first, second], nextCursor: 2 });
    await fixture.whenStable();
    fixture.detectChanges();

    const component = fixture.componentInstance;
    expect(component['participants']().map((user) => user.uid)).toEqual([1, 2]);
    expect(component['cursor']()).toBe(2);

    const continuation = component['load'](true);
    const next = http.expectOne(participantRequest());
    expect(next.request.params.get('cursor')).toBe('2');
    next.flush({ participants: [third], nextCursor: null });
    await continuation;
    fixture.detectChanges();

    expect(component['participants']().map((user) => user.uid)).toEqual([1, 2, 3]);
    expect(component['cursor']()).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).toBeNull();
  });

  it('keeps rows and the continuation cursor through a retryable paging failure', async () => {
    const fixture = open();
    http.expectOne(participantRequest()).flush({ participants: [first], nextCursor: 1 });
    await fixture.whenStable();
    const component = fixture.componentInstance;

    const continuation = component['load'](true);
    http.expectOne(participantRequest()).flush({}, { status: 503, statusText: 'Unavailable' });
    await continuation;
    expect(component['participants']()).toEqual([first]);
    expect(component['cursor']()).toBe(1);
    expect(component['error']()).toBe(true);

    component['retry']();
    const retry = http.expectOne(participantRequest());
    expect(retry.request.params.get('cursor')).toBe('1');
    retry.flush({ participants: [second] });
    await fixture.whenStable();

    expect(component['participants']()).toEqual([first, second]);
    expect(component['cursor']()).toBeUndefined();
    expect(component['error']()).toBe(false);
  });

  it('cancels and ignores a roster response when the chat scope changes', async () => {
    const fixture = open();
    const previous = http.expectOne(participantRequest());
    const nextChatId = encodeId('200');
    fixture.componentRef.setInput('chatId', nextChatId);
    fixture.detectChanges();

    expect(previous.cancelled).toBe(true);
    http.expectOne(participantRequest('200')).flush({ participants: [third] });
    await fixture.whenStable();

    expect(fixture.componentInstance['participants']()).toEqual([third]);
  });

  it('cancels a previous thread in the same chat and cancels reads on destruction', async () => {
    const fixture = open();
    const previous = http.expectOne(participantRequest());
    fixture.componentRef.setInput('rootId', encodeId('201'));
    fixture.detectChanges();
    expect(previous.cancelled).toBe(true);
    http.expectOne(participantRequest(wireChat.id, '201')).flush({ participants: [third] });
    await fixture.whenStable();
    expect(fixture.componentInstance['participants']()).toEqual([third]);
    const refreshing = fixture.componentInstance['load']();
    const pending = http.expectOne(participantRequest(wireChat.id, '201'));
    fixture.destroy();
    await refreshing;
    expect(pending.cancelled).toBe(true);
  });

  it('preserves a known roster during refresh and retries its first page on failure', async () => {
    const fixture = open();
    http.expectOne(participantRequest()).flush({ participants: [first], nextCursor: 1 });
    await fixture.whenStable();
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('ion-item');
    const refresh = fixture.componentInstance['load']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-item')).toBe(row);
    expect(fixture.nativeElement.querySelector('.page-loading')).toBeNull();
    http.expectOne(participantRequest()).flush({}, { status: 503, statusText: 'Unavailable' });
    await refresh;
    fixture.componentInstance['retry']();
    const retry = http.expectOne(participantRequest());
    expect(retry.request.params.has('cursor')).toBe(false);
    retry.flush({ participants: [{ ...first, name: 'Updated participant' }], nextCursor: null });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-item')).toBe(row);
    expect(row.textContent).toContain('Updated participant');
    expect(fixture.nativeElement.querySelector('ion-infinite-scroll')).toBeNull();
  });

  it('clears a retained roster and disables retry when its scope loses access', async () => {
    const fixture = open();
    http.expectOne(participantRequest()).flush({ participants: [first], nextCursor: 1 });
    await fixture.whenStable();
    const component = fixture.componentInstance;

    const refresh = component['load']();
    expect(component['participants']()).toEqual([first]);
    http.expectOne(participantRequest()).flush({}, { status: 403, statusText: 'Forbidden' });
    await refresh;

    expect(component['participants']()).toEqual([]);
    expect(component['cursor']()).toBeUndefined();
    expect(component['error']()).toBe(true);
    expect(component['retryable']()).toBe(false);
  });
});
