import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { vi } from 'vitest';
import { LinkPreviewStatus, type LinkPreviewResponse } from '../../generated/models';
import { MessageLinkPreviews } from './message-link-previews';

describe('MessageLinkPreviews', () => {
  const pending = (url = 'https://example.com/', expiresAt = '2026-01-01T00:00:10Z'): LinkPreviewResponse => ({
    url,
    expiresAt,
    status: LinkPreviewStatus.pending,
  });
  const ready = (url = 'https://example.com/'): LinkPreviewResponse => ({
    url,
    title: 'Example title',
    status: LinkPreviewStatus.ready,
  });
  const router = { navigateByUrl: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    router.navigateByUrl.mockReset();
    TestBed.configureTestingModule({
      imports: [MessageLinkPreviews],
      providers: [{ provide: Router, useValue: router }],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function render(previews: LinkPreviewResponse[]) {
    const fixture = TestBed.createComponent(MessageLinkPreviews);
    fixture.componentRef.setInput('previews', previews);
    fixture.detectChanges();
    return fixture;
  }

  it('replaces pending in place with ready and removes unavailable', () => {
    const fixture = render([pending()]);
    expect(fixture.nativeElement.querySelectorAll('.skeleton')).toHaveLength(1);
    fixture.componentRef.setInput('previews', [ready()]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card').textContent).toContain('Example title');
    expect(fixture.nativeElement.querySelector('.domain').textContent).toContain('example.com');
    fixture.componentRef.setInput('previews', [{ ...ready(), status: LinkPreviewStatus.unavailable }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card')).toBeNull();
  });

  it('shows no more than three cards without overflow controls', () => {
    const fixture = render(Array.from({ length: 5 }, (_, i) => ready(`https://example${i}.com/`)));
    expect(fixture.nativeElement.querySelectorAll('.card')).toHaveLength(3);
    expect(fixture.nativeElement.textContent).not.toContain('+2');
  });

  it('never flashes a skeleton for an already expired history entry', () => {
    const fixture = render([pending('https://example.com/', '2025-12-31T23:59:59Z')]);
    expect(fixture.nativeElement.querySelector('.card')).toBeNull();
  });

  it('expires once despite clock rollback and refreshed input, and disposes its timer', () => {
    const entry = pending();
    const fixture = render([entry]);
    vi.setSystemTime(new Date('2025-12-31T23:59:00Z'));
    vi.advanceTimersByTime(10000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card')).toBeNull();
    fixture.componentRef.setInput('previews', [{ ...entry }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card')).toBeNull();
    fixture.componentRef.setInput('previews', [pending('https://other.com/')]);
    fixture.detectChanges();
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses cached images and replaces failures with a same-size letter tile', () => {
    const fixture = render([{ ...ready(), image: { url: '/media/cached.webp', width: 64, height: 64 } }]);
    const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/media/cached.webp');
    image.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.letter').textContent).toContain('E');
  });

  it('routes unmodified same-origin app links, but leaves modified and external links to the browser', () => {
    vi.stubGlobal('location', new URL('https://chahua.app/'));
    const fixture = render([ready('https://chahua.app/chats/123?x=1#msg=2')]);
    let anchor = fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/chats/123?x=1#msg=2');
    router.navigateByUrl.mockClear();
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    anchor.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    fixture.componentRef.setInput('previews', [ready('https://example.com/')]);
    fixture.detectChanges();
    anchor = fixture.nativeElement.querySelector('a');
    const external = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(external);
    expect(external.defaultPrevented).toBe(false);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    fixture.componentRef.setInput('interactive', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('a')).toBeNull();
  });
});
