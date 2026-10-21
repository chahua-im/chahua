import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { PrivacySettings } from './privacy-settings';
import { BlockedUsers } from '../blocked-users/blocked-users';

const blocksUrl = '/_api/blocks';
const friendsUrl = '/_api/friends/me/settings';
const receiptsUrl = '/_api/me/read-receipt-settings';
const presenceUrl = '/_api/me/presence-settings';

describe('Privacy settings', () => {
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('keeps all four links available while summaries arrive independently', async () => {
    const fixture = TestBed.createComponent(PrivacySettings);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    const page: HTMLElement = fixture.nativeElement;
    expect(Array.from(page.querySelectorAll('ion-item')).map((item) => item.getAttribute('href'))).toEqual([
      '/settings/blocked-users',
      '/settings/friend-verification',
      '/settings/presence',
      '/settings/read-receipts',
    ]);
    expect(page.querySelectorAll('ion-note')).toHaveLength(0);
    expect(page.querySelectorAll('ion-spinner')).toHaveLength(4);
    http.expectOne(blocksUrl).flush({ blocks: [] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect(page.querySelector('ion-note')?.textContent?.trim()).toBe('无');
    expect(page.querySelectorAll('ion-spinner')).toHaveLength(3);
    http.expectOne(friendsUrl).flush({ mode: 'direct' });
    http.expectOne(presenceUrl).flush({ visibility: 'everyone' });
    http.expectOne(receiptsUrl).flush({ visibility: 'friends' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect(Array.from(page.querySelectorAll('ion-note')).map((note) => note.textContent?.trim())).toEqual([
      '无',
      '允许任何人',
      '所有人',
      '开启',
    ]);
    fixture.destroy();
    const returned = TestBed.createComponent(PrivacySettings);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    returned.detectChanges();
    http.expectOne(blocksUrl).flush({ blocks: [{ since: '', user: { uid: 42, username: 'Blocked', gender: 0 } }] });
    http.expectOne(friendsUrl).flush({ mode: 'question', question: 'test' });
    http.expectOne(presenceUrl).flush({ visibility: 'nobody' });
    http.expectOne(receiptsUrl).flush({ visibility: 'nobody' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    returned.detectChanges();
    expect(
      Array.from(returned.nativeElement.querySelectorAll('ion-note') as NodeListOf<HTMLElement>).map((note) =>
        note.textContent?.trim(),
      ),
    ).toEqual(['1', '需要回答问题并由我确认', '不允许任何人', '关闭']);
  });

  it('retries failed summaries without replacing successful summaries', async () => {
    const fixture = TestBed.createComponent(PrivacySettings);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    http.expectOne(blocksUrl).flush({}, { status: 503, statusText: 'Unavailable' });
    http.expectOne(friendsUrl).flush({ mode: 'need_message' });
    http.expectOne(presenceUrl).flush({ visibility: 'friends' });
    http.expectOne(receiptsUrl).flush({}, { status: 503, statusText: 'Unavailable' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    const page: HTMLElement = fixture.nativeElement;
    const rows = page.querySelectorAll<HTMLElement>('ion-item');
    const notes = [rows[1].querySelector('ion-note'), rows[2].querySelector('ion-note')];
    expect(rows[0].textContent).toContain('加载失败，点击重试');
    expect(rows[3].textContent).toContain('加载失败，点击重试');
    expect(rows[0].getAttribute('href')).toBeNull();
    expect(page.querySelector('app-load-error')).toBeNull();
    rows[0].click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect([rows[1].querySelector('ion-note'), rows[2].querySelector('ion-note')]).toEqual(notes);
    http.expectNone(friendsUrl);
    http.expectNone(presenceUrl);
    http.expectNone(receiptsUrl);
    expect(rows[3].textContent).toContain('加载失败，点击重试');
    http.expectOne(blocksUrl).flush({ blocks: [] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect(rows[0].getAttribute('href')).toBe('/settings/blocked-users');
    expect(rows[0].querySelector('ion-note')?.textContent?.trim()).toBe('无');
    rows[3].click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    http.expectNone(blocksUrl);
    http.expectOne(receiptsUrl).flush({ visibility: 'friends' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect(rows[3].getAttribute('href')).toBe('/settings/read-receipts');
    expect(rows[3].querySelector('ion-note')?.textContent?.trim()).toBe('开启');
  });

  it.each([blocksUrl, friendsUrl, presenceUrl, receiptsUrl])(
    'retries %s from the error text after repeated failures without navigating',
    async (endpoint) => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      const fixture = TestBed.createComponent(PrivacySettings);
      const settle = async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        TestBed.tick();
        fixture.detectChanges();
      };
      await settle();
      const urls = [blocksUrl, friendsUrl, presenceUrl, receiptsUrl];
      const values = [{ blocks: [] }, { mode: 'direct' }, { visibility: 'everyone' }, { visibility: 'friends' }];
      urls.forEach((url, index) => {
        const request = http.expectOne(url);
        if (url === endpoint) request.flush({}, { status: 503, statusText: 'Unavailable' });
        else request.flush(values[index]);
      });
      await settle();
      const row = (fixture.nativeElement as HTMLElement).querySelectorAll('ion-item')[urls.indexOf(endpoint)];
      for (let attempt = 0; attempt < 2; attempt++) {
        const note = row.querySelector<HTMLElement>('ion-note')!;
        expect(note.textContent).toContain('加载失败，点击重试');
        note.click();
        await settle();
        expect(row.querySelector('ion-spinner')).not.toBeNull();
        expect(navigate).not.toHaveBeenCalled();
        urls.filter((url) => url !== endpoint).forEach((url) => http.expectNone(url));
        const retry = http.expectOne(endpoint);
        if (attempt === 0) retry.flush({}, { status: 503, statusText: 'Unavailable' });
        else retry.flush(values[urls.indexOf(endpoint)]);
        await settle();
      }
      expect(row.textContent).not.toContain('加载失败，点击重试');
      expect(row.querySelector('ion-spinner')).toBeNull();
      expect(row.getAttribute('href')).not.toBeNull();
    },
  );

  it('shows blocked users with links to their profile and supports retry', async () => {
    const fixture = TestBed.createComponent(BlockedUsers);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    http.expectOne(blocksUrl).flush({}, { status: 503, statusText: 'Unavailable' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    const page: HTMLElement = fixture.nativeElement;
    page.querySelector<HTMLElement>('app-load-error ion-button')!.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    http.expectOne(blocksUrl).flush({ blocks: [{ since: '', user: { uid: 42, username: 'Blocked', gender: 0 } }] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    fixture.detectChanges();
    expect(page.querySelector('ion-item[href="/profile/42"]')?.textContent).toContain('Blocked');
    expect(page.querySelector('app-load-error')).toBeNull();
  });
});
