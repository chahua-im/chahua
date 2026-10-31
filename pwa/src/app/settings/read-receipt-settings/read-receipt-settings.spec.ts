import { EMPTY } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular';
import { RpcTestPeer, provideRpcTesting } from '../../api/rpc-testing';
import { ChatStore } from '../../chats/chat-store';
import { ReadReceiptSettings } from './read-receipt-settings';

describe('Read receipt toggle', () => {
  let peer: RpcTestPeer;
  const invalidate = vi.fn();
  beforeEach(() => {
    invalidate.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        provideRpcTesting(),
        { provide: ChatStore, useValue: { invalidateReadReceiptPrivacy: invalidate, privacyOverrides$: EMPTY } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('saves immediately, blocks duplicate changes and retries a failed write', async () => {
    const fixture = TestBed.createComponent(ReadReceiptSettings);
    const settings = peer.expect('privacy.getReadReceiptSettings');
    settings.flush({ visibility: 'friends' });
    await fixture.whenStable();
    fixture.detectChanges();
    (
      await peer.expectAsync(
        'presence.watch',
        (params) =>
          typeof params['requestId'] === 'number' &&
          Array.isArray(params['userIds']) &&
          params['userIds'].length === 0 &&
          Array.isArray(params['chatIds']) &&
          params['chatIds'].length === 0,
      )
    ).flush(null);
    const page: HTMLElement = fixture.nativeElement;
    const toggle = page.querySelector('ion-toggle')!;
    expect(toggle.checked).toBe(true);
    expect(page.querySelector('ion-radio')).toBeNull();
    expect(page.textContent).not.toContain('仅好友');
    toggle.dispatchEvent(new CustomEvent('ionChange', { detail: { checked: false } }));
    fixture.detectChanges();
    expect(toggle.disabled).toBe(true);
    toggle.dispatchEvent(new CustomEvent('ionChange', { detail: { checked: true } }));
    peer.expect('privacy.updateReadReceiptSettings', { visibility: 'nobody' }).error(1503);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(invalidate).not.toHaveBeenCalled();
    expect(toggle.checked).toBe(true);
    const retry = Array.from(page.querySelectorAll('ion-button')).find(
      (button) => button.textContent?.trim() === '重试',
    )!;
    retry.click();
    peer.expect('privacy.updateReadReceiptSettings', { visibility: 'nobody' }).flush({ visibility: 'nobody' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(page.textContent).not.toContain('保存失败');
  });
});
