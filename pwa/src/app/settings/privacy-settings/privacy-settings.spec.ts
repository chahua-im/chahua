import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';
import {
  FriendAddVerificationMode,
  PresenceVisibility,
  ReadReceiptVisibility,
  type FriendSettingsResponse,
  type ListBlocksResponse,
  type PresenceSettingsResponse,
  type ReadReceiptSettingsResponse,
} from '../../../generated/models';
import { RpcTestPeer, provideRpcTesting } from '../../api/rpc-testing';
import { PrivacySettings } from './privacy-settings';
import { BlockedUsers } from '../blocked-users/blocked-users';

type SummaryMethod =
  'blocks.list' | 'friends.getSettings' | 'privacy.getPresenceSettings' | 'privacy.getReadReceiptSettings';

type SummaryResults = [
  ListBlocksResponse,
  FriendSettingsResponse,
  PresenceSettingsResponse,
  ReadReceiptSettingsResponse,
];

const methods: readonly SummaryMethod[] = [
  'blocks.list',
  'friends.getSettings',
  'privacy.getPresenceSettings',
  'privacy.getReadReceiptSettings',
];

const summaries: SummaryResults = [
  { blocks: [] },
  { mode: FriendAddVerificationMode.direct },
  { visibility: PresenceVisibility.everyone, exceptionCount: 0 },
  { visibility: ReadReceiptVisibility.friends, exceptionCount: 0 },
];

describe('Privacy settings', () => {
  let peer: RpcTestPeer;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideIonicAngular({ animated: false }), provideRouter([]), provideRpcTesting()],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => peer.verify());

  async function settle(fixture: { detectChanges(): void }) {
    await Promise.resolve();
    TestBed.tick();
    fixture.detectChanges();
  }

  function flushSummaries(values = summaries) {
    methods.forEach((method, index) => peer.expect(method).flush(values[index]));
  }

  it('keeps all four links available while summaries arrive independently', async () => {
    const fixture = TestBed.createComponent(PrivacySettings);
    await settle(fixture);
    const page: HTMLElement = fixture.nativeElement;
    expect(Array.from(page.querySelectorAll('ion-item')).map((item) => item.getAttribute('href'))).toEqual([
      '/settings/blocked-users',
      '/settings/friend-verification',
      '/settings/presence',
      '/settings/read-receipts',
    ]);
    expect(page.querySelectorAll('ion-note')).toHaveLength(0);
    expect(page.querySelectorAll('ion-spinner')).toHaveLength(4);
    peer.expect('blocks.list').flush({ blocks: [] });
    await settle(fixture);
    expect(page.querySelector('ion-note')?.textContent?.trim()).toBe('无');
    expect(page.querySelectorAll('ion-spinner')).toHaveLength(3);
    peer.expect('friends.getSettings').flush({ mode: 'direct' });
    peer.expect('privacy.getPresenceSettings').flush({ visibility: 'everyone', exceptionCount: 0 });
    peer.expect('privacy.getReadReceiptSettings').flush({ visibility: 'friends', exceptionCount: 0 });
    await settle(fixture);
    expect(Array.from(page.querySelectorAll('ion-note')).map((note) => note.textContent?.trim())).toEqual([
      '无',
      '允许任何人',
      '所有人',
      '开启',
    ]);
    fixture.destroy();
    const returned = TestBed.createComponent(PrivacySettings);
    await settle(returned);
    flushSummaries([
      { blocks: [{ since: '', user: { uid: 42, username: 'Blocked', gender: 0 } }] },
      { mode: FriendAddVerificationMode.question, question: 'test' },
      { visibility: PresenceVisibility.nobody, exceptionCount: 2 },
      { visibility: ReadReceiptVisibility.nobody, exceptionCount: 1 },
    ]);
    await settle(returned);
    expect(
      Array.from(returned.nativeElement.querySelectorAll('ion-note') as NodeListOf<HTMLElement>).map((note) =>
        note.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['1', '需要回答问题并由我确认', '不允许任何人 （2 个例外）', '关闭 （1 个例外）']);
  });

  it('retries failed summaries without replacing successful summaries', async () => {
    const fixture = TestBed.createComponent(PrivacySettings);
    await settle(fixture);
    peer.expect('blocks.list').error(1503);
    peer.expect('friends.getSettings').flush({ mode: 'need_message' });
    peer.expect('privacy.getPresenceSettings').flush({ visibility: 'friends' });
    peer.expect('privacy.getReadReceiptSettings').error(1503);
    await settle(fixture);
    const page: HTMLElement = fixture.nativeElement;
    const rows = page.querySelectorAll<HTMLElement>('ion-item');
    const notes = [rows[1].querySelector('ion-note'), rows[2].querySelector('ion-note')];
    expect(rows[0].textContent).toContain('加载失败，点击重试');
    expect(rows[3].textContent).toContain('加载失败，点击重试');
    rows[0].click();
    await settle(fixture);
    expect([rows[1].querySelector('ion-note'), rows[2].querySelector('ion-note')]).toEqual(notes);
    peer.expect('blocks.list').flush({ blocks: [] });
    await settle(fixture);
    expect(rows[0].getAttribute('href')).toBe('/settings/blocked-users');
    rows[3].click();
    await settle(fixture);
    peer.expect('privacy.getReadReceiptSettings').flush({ visibility: 'friends' });
    await settle(fixture);
    expect(rows[3].getAttribute('href')).toBe('/settings/read-receipts');
  });

  it.each(methods)('retries %s from the error text without navigating', async (method) => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const fixture = TestBed.createComponent(PrivacySettings);
    await settle(fixture);
    methods.forEach((candidate, index) => {
      const request = peer.expect(candidate);
      if (candidate === method) request.error(1503);
      else request.flush(summaries[index]);
    });
    await settle(fixture);
    const row = (fixture.nativeElement as HTMLElement).querySelectorAll('ion-item')[methods.indexOf(method)];
    for (let attempt = 0; attempt < 2; attempt++) {
      const note = row.querySelector<HTMLElement>('ion-note')!;
      expect(note.textContent).toContain('加载失败，点击重试');
      note.click();
      await settle(fixture);
      expect(navigate).not.toHaveBeenCalled();
      const retry = peer.expect(method);
      if (attempt === 0) retry.error(1503);
      else retry.flush(summaries[methods.indexOf(method)]);
      await settle(fixture);
    }
    expect(row.textContent).not.toContain('加载失败，点击重试');
    expect(row.getAttribute('href')).not.toBeNull();
  });

  it('shows blocked users with links to their profile and supports retry', async () => {
    const fixture = TestBed.createComponent(BlockedUsers);
    await settle(fixture);
    peer.expect('blocks.list').error(1503);
    await settle(fixture);
    const page: HTMLElement = fixture.nativeElement;
    page.querySelector<HTMLElement>('app-load-error ion-button')!.click();
    await settle(fixture);
    peer.expect('blocks.list').flush({ blocks: [{ since: '', user: { uid: 42, username: 'Blocked', gender: 0 } }] });
    await settle(fixture);
    expect(page.querySelector('ion-item[href="/profile/42"]')?.textContent).toContain('Blocked');
    expect(page.querySelector('app-load-error')).toBeNull();
  });
});
