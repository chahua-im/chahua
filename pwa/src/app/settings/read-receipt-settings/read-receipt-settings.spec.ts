import { EMPTY } from 'rxjs';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { ChatStore } from '../../chats/chat-store';
import { ReadReceiptSettings } from './read-receipt-settings';

describe('Read receipt toggle', () => {
  let http: HttpTestingController;
  const invalidate = vi.fn();
  const url = '/_api/me/read-receipt-settings';
  beforeEach(() => {
    invalidate.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: ChatStore, useValue: { invalidateReadReceiptPrivacy: invalidate, privacyOverrides$: EMPTY } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('saves immediately, blocks duplicate changes and retries a failed write', async () => {
    const fixture = TestBed.createComponent(ReadReceiptSettings);
    http.expectOne(url).flush({ visibility: 'friends' });
    await fixture.whenStable();
    fixture.detectChanges();
    const page: HTMLElement = fixture.nativeElement;
    const toggle = page.querySelector('ion-toggle')!;
    expect(toggle.checked).toBe(true);
    expect(page.querySelector('ion-radio')).toBeNull();
    expect(page.textContent).not.toContain('仅好友');
    toggle.dispatchEvent(new CustomEvent('ionChange', { detail: { checked: false } }));
    fixture.detectChanges();
    expect(toggle.disabled).toBe(true);
    toggle.dispatchEvent(new CustomEvent('ionChange', { detail: { checked: true } }));
    const write = http.expectOne(url);
    expect(write.request.body).toEqual({ visibility: 'nobody' });
    write.flush({}, { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(invalidate).not.toHaveBeenCalled();
    expect(toggle.checked).toBe(true);
    const retry = Array.from(page.querySelectorAll('ion-button')).find(
      (button) => button.textContent?.trim() === '重试',
    )!;
    retry.click();
    http.expectOne(url).flush({ visibility: 'nobody' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(page.textContent).not.toContain('保存失败');
  });
});
