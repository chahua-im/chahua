import { IonModal } from '@ionic/angular';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { RpcApi } from '../../generated/rpc-api';
import { LinkPreviewInputStatus, LinkPreviewStatus, type LinkPreviewResponse } from '../../generated/models';
import { testChat } from '../api/testing';
import { DraftLinkPreviews } from './draft-link-previews';
import { draftLinkUrls } from './draft-link-urls';

describe('DraftLinkPreviews', () => {
  const urls = [
    'https://one.example/',
    'https://two.example/',
    'https://three.example/',
    'https://four.example/',
    'https://five.example/',
  ];
  let requests: { url: string; result: Subject<LinkPreviewResponse[]> }[];
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.spyOn(IonModal.prototype, 'isOpen', 'set').mockImplementation(() => {});
    requests = [];
    fetch = vi.fn(({ urls }: { urls: string[] }) => {
      const result = new Subject<LinkPreviewResponse[]>();
      requests.push({ url: urls[0], result });
      return result;
    });
    TestBed.configureTestingModule({
      providers: [{ provide: RpcApi, useValue: { messages: { previewLinks: fetch } } }],
    });
  });
  afterEach(() => vi.restoreAllMocks());
  function render() {
    const fixture = TestBed.createComponent(DraftLinkPreviews);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('scope', 'send/one');
    fixture.componentRef.setInput('text', urls.join(' '));
    fixture.detectChanges();
    return fixture;
  }
  function finish(index: number, status = LinkPreviewStatus.ready) {
    requests[index].result.next([{ url: requests[index].url, status, title: 'Title ' + index }]);
    requests[index].result.complete();
  }
  it('only fetches on explicit opening, limits to three, and promotes after disabling', async () => {
    const fixture = render();
    expect(fetch).not.toHaveBeenCalled();
    fixture.componentRef.setInput('text', urls.join('\n') + ' extra');
    fixture.detectChanges();
    expect(fetch).not.toHaveBeenCalled();
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    expect(requests.map((r) => r.url)).toEqual(urls.slice(0, 3));
    finish(0, LinkPreviewStatus.unavailable);
    finish(1);
    finish(2);
    await fixture.whenStable();
    expect(fetch).toHaveBeenCalledTimes(3);
    fixture.nativeElement.querySelector('.preview-choice').click();
    fixture.detectChanges();
    expect(requests[3].url).toBe(urls[3]);
    expect(fixture.componentInstance.choices()).toContainEqual({
      url: urls[0],
      status: LinkPreviewInputStatus.disabled,
    });
    finish(3);
    await fixture.whenStable();
    fixture.componentInstance['toggle'](urls[0]);
    fixture.detectChanges();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fixture.componentInstance['selected']()).toEqual(urls.slice(0, 3));
    expect(fixture.nativeElement.querySelectorAll('.muted')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.standalone-card')).toBeNull();
  });
  it('retains loaded DOM, does not fetch additions while closed, and rejects old-scope responses', async () => {
    const fixture = render();
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    finish(0);
    await fixture.whenStable();
    const first = fixture.nativeElement.querySelector('.entry');
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    fixture.componentRef.setInput('text', urls[0] + ' https://new.example/');
    fixture.detectChanges();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fixture.nativeElement.querySelector('.entry')).toBe(first);
    fixture.componentRef.setInput('scope', 'edit/two');
    fixture.detectChanges();
    finish(1);
    finish(2);
    await fixture.whenStable();
    expect(fixture.componentInstance['results']()).toEqual({});
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    expect(requests.slice(3).map((r) => r.url)).toEqual([urls[0], 'https://new.example/']);
    finish(3);
    finish(4);
    await fixture.whenStable();
  });
  it('uses existing edit previews and preserves disabled choices without requesting them', () => {
    const fixture = render();
    fixture.componentRef.setInput('initial', [{ url: urls[0], status: LinkPreviewStatus.ready, title: 'Saved title' }]);
    fixture.componentRef.setInput('choices', [{ url: urls[1], status: LinkPreviewInputStatus.disabled }]);
    fixture.componentRef.setInput('scope', 'edit/existing');
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    expect(requests.map((r) => r.url)).toEqual([urls[2], urls[3]]);
    expect(fixture.nativeElement.textContent).toContain('Saved title');
    expect(fixture.componentInstance.snapshot()).toContainEqual({ url: urls[1], status: LinkPreviewStatus.disabled });
  });
  it('automatically loads the first displayable preview without opening management or fetching later links', async () => {
    const fixture = render();
    fixture.componentRef.setInput('automatic', true);
    fixture.detectChanges();
    expect(requests.map((request) => request.url)).toEqual([urls[0]]);
    finish(0, LinkPreviewStatus.unavailable);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.map((request) => request.url)).toEqual(urls.slice(0, 2));
    expect(fixture.componentInstance.fallbackUrl()).toBe(urls[0]);
    finish(1);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.firstReady()?.url).toBe(urls[1]);
    expect(fixture.componentInstance.fallbackUrl()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.open()).toBe(false);
    fixture.componentInstance['toggle'](urls[1]);
    fixture.detectChanges();
    expect(requests[2].url).toBe(urls[2]);
    finish(2);
    await fixture.whenStable();
    expect(fixture.componentInstance.firstReady()?.url).toBe(urls[2]);
  });

  it('closes the modal without clearing choices or cached previews and reopens without fetching again', async () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    finish(0);
    finish(1);
    finish(2);
    await fixture.whenStable();
    fixture.componentInstance['toggle'](urls[4]);
    fixture.detectChanges();
    const modal = fixture.nativeElement.querySelector('ion-modal');
    const first = fixture.nativeElement.querySelector('.entry');
    modal.dispatchEvent(new CustomEvent('willDismiss'));
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(fixture.componentInstance.choices()).toContainEqual({
      url: urls[4],
      status: LinkPreviewInputStatus.disabled,
    });
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.entry')).toBe(first);
    expect(fixture.componentInstance.firstReady()?.url).toBe(urls[0]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('detects eligible links locally and normalizes duplicates', () => {
    expect(
      draftLinkUrls(
        'https://EXAMPLE.com https://example.com/ [test](https://two.example/a?q=1#x) http://no.example/ https://127.0.0.1/ https://user@private.example/ https://no.example:444/',
      ),
    ).toEqual(['https://example.com/', 'https://two.example/a?q=1#x']);
  });
});
