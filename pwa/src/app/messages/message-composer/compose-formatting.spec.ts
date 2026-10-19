import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { GroupRole } from '../../../generated/models';
import { testChat } from '../../api/testing';
import { MessageComposer } from './message-composer';

describe('Composer formatting toolbar', () => {
  let fixture: ComponentFixture<MessageComposer>;
  let composer: MessageComposer;
  let http: HttpTestingController;
  let input: HTMLTextAreaElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MessageComposer);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    composer = fixture.componentInstance;
    input = await composer['textarea']()!.getInputElement();
    await vi.waitFor(() => composer['nativeInput']);
  });
  afterEach(() => {
    fixture.destroy();
    http.verify({ ignoreCancelled: true });
    vi.restoreAllMocks();
  });

  function type(text: string, display = text) {
    composer.text.set(text);
    input.value = display;
  }
  function focusAndSelect(start: number, end: number) {
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    input.setSelectionRange(start, end);
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    fixture.detectChanges();
  }
  function toolbar() {
    return (fixture.nativeElement as HTMLElement).querySelector('[data-format-toolbar]');
  }
  function click(selector: string) {
    const target = (fixture.nativeElement as HTMLElement).querySelector(selector);
    if (!target) throw new Error('missing ' + selector);
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  async function flush() {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fixture.detectChanges();
  }
  function key(keyValue: string, init: KeyboardEventInit = {}) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: keyValue, bubbles: true, cancelable: true, ...init }));
    return input;
  }

  it('shows the floating toolbar when text is selected and hides it on collapse', () => {
    type('hello world');
    focusAndSelect(0, 5);
    expect(toolbar()).toBeTruthy();

    input.setSelectionRange(5, 5);
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(toolbar()).toBeNull();
  });

  it('keeps the toolbar hidden while the mention menu is open', () => {
    type('hello @');
    composer['suggestions'].set([{ uid: 2, gender: 0, username: 'a', role: GroupRole.member, joinedAt: '' }]);
    focusAndSelect(0, 5);
    expect(toolbar()).toBeNull();
  });

  it('hides the toolbar when the textarea loses focus', () => {
    type('hello world');
    focusAndSelect(0, 5);
    expect(toolbar()).toBeTruthy();
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    fixture.detectChanges();
    expect(toolbar()).toBeNull();
  });

  it('wraps the selection in ** via the toolbar bold button and restores the cursor', async () => {
    type('hello world');
    focusAndSelect(0, 5);
    click('[data-format-bold]');
    await flush();

    expect(composer.text()).toBe('**hello** world');
    expect(input.selectionStart).toBe(9);
    expect(input.selectionEnd).toBe(9);
    expect(toolbar()).toBeNull();
  });

  it('wraps the selection in * and ~~ via italic and strike buttons', async () => {
    type('hello world');
    focusAndSelect(0, 5);
    click('[data-format-italic]');
    await flush();
    expect(composer.text()).toBe('*hello* world');

    type('*hello* world');
    focusAndSelect(8, 13);
    click('[data-format-strike]');
    await flush();
    expect(composer.text()).toBe('*hello* ~~world~~');
  });

  it('fences the selection via the toolbar code button', async () => {
    type('hello world');
    focusAndSelect(0, 5);
    click('[data-format-code]');
    await flush();
    expect(composer.text()).toBe('```\nhello\n``` world');
  });

  it('prefixes every selected line with > via the toolbar quote button', async () => {
    type('first\nsecond');
    focusAndSelect(0, 12);
    click('[data-format-quote]');
    await flush();
    expect(composer.text()).toBe('> first\n> second');
  });

  it('applies a typed link URL to the selection', async () => {
    type('see hello now');
    focusAndSelect(4, 9);
    click('[data-format-link]');
    fixture.detectChanges();

    const urlInput = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-format-url-input]',
    ) as HTMLInputElement;
    expect(urlInput).toBeTruthy();
    urlInput.value = 'example.com/docs';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-format-url-apply]');
    await flush();

    expect(composer.text()).toBe('see [hello](https://example.com/docs) now');
  });

  it('applies keyboard shortcuts for every formatting kind', async () => {
    type('hello world');
    focusAndSelect(0, 5);
    key('b', { ctrlKey: true });
    await flush();
    expect(composer.text()).toBe('**hello** world');

    type('**hello** __world__');
    focusAndSelect(12, 17);
    key('q', { ctrlKey: true });
    await flush();
    expect(composer.text()).toBe('**hello** __> world__');
  });

  it('leaves collapsed selections alone', async () => {
    type('plain');
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    fixture.detectChanges();
    key('b', { ctrlKey: true });
    await flush();
    expect(composer.text()).toBe('plain');
    expect(toolbar()).toBeNull();
  });

  it('does not fire formatting shortcuts during IME composition', async () => {
    type('plain');
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    input.setSelectionRange(0, 5);
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    fixture.detectChanges();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true, isComposing: true }),
    );
    await flush();
    expect(composer.text()).toBe('plain');
  });

  it('keeps a mention wired when the toolbar wraps it in bold', async () => {
    type('你好 @[uid:7]', '你好 @User 7');
    focusAndSelect(3, 10);
    click('[data-format-bold]');
    await flush();
    expect(composer.text()).toBe('你好 **@[uid:7]**');
  });
});
