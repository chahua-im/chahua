import { Preferences } from '../../settings/preferences';
import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { testChat, testMessage } from '../../api/testing';
import { markdownEngine } from '../../markdown/engine';
import { MessageComposer } from './message-composer';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Composer formatting shortcuts', () => {
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
  });
  afterEach(() => {
    fixture.destroy();
    http.verify({ ignoreCancelled: true });
  });

  function select(text: string, display = text, start = 0, end = display.length) {
    composer.text.set(text);
    fixture.detectChanges();
    input.value = display;
    input.focus();
    input.setSelectionRange(start, end);
  }
  async function key(value: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    await Promise.resolve();
    fixture.detectChanges();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fixture.detectChanges();
    return event;
  }

  it.each(['b', 'i'])('leaves %s shortcuts untouched when Markdown is disabled', async (value) => {
    const preferences = TestBed.inject(Preferences);
    preferences.setMarkdownEnabled(false);
    try {
      for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
        select('hello');
        const event = await key(value, init);
        expect(composer.text()).toBe('hello');
        expect(event.defaultPrevented).toBe(false);
      }
    } finally {
      preferences.setMarkdownEnabled(true);
    }
  });

  it.each([
    { key: 'b', ctrlKey: true, marker: '**', tag: 'strong' },
    { key: 'i', metaKey: true, marker: '__', tag: 'em' },
  ])('formats selected paragraphs with $key and leaves no toolbar', async ({ key: value, marker, tag, ...init }) => {
    select(' first \n\n second ');
    const event = await key(value, init);
    expect(event.defaultPrevented).toBe(true);
    expect(composer.text()).toBe(` ${marker}first${marker} \n\n ${marker}second${marker} `);
    expect(markdownEngine.render(composer.text())).toContain(`<${tag}>second</${tag}>`);
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(fixture.nativeElement.querySelector('app-format-toolbar')).toBeNull();
  });

  it('keeps two same-name mentions wired to different users across a shortcut', async () => {
    fixture.componentRef.setInput('editing', {
      ...testMessage,
      mentions: [
        { uid: 7, username: '小明', gender: 0 },
        { uid: 8, username: '小明', gender: 0 },
      ],
    });
    fixture.detectChanges();
    select('@[uid:7] @[uid:8]', '@小明 @小明');
    await key('b', { ctrlKey: true });
    expect(composer.text()).toBe('**@[uid:7] @[uid:8]**');
    expect(input.value).toBe('**@小明 @小明**');
  });

  it('does not move a mention onto an identical plain name inside the selection', async () => {
    fixture.componentRef.setInput('editing', {
      ...testMessage,
      mentions: [
        { uid: 7, username: '小明', gender: 0 },
        { uid: 8, username: '小明', gender: 0 },
      ],
    });
    fixture.detectChanges();
    select('@[uid:7] @小明 @[uid:8]', '@小明 @小明 @小明');
    await key('b', { ctrlKey: true });
    expect(composer.text()).toBe('**@[uid:7] @小明 @[uid:8]**');
  });

  it('keeps shortcuts working when the focused input enters and leaves edit mode', async () => {
    select('hello');
    fixture.componentRef.setInput('editing', testMessage);
    fixture.detectChanges();
    await key('i', { ctrlKey: true });
    expect(composer.text()).toBe('__hello__');
    fixture.componentRef.setInput('editing', undefined);
    fixture.detectChanges();
    select('world');
    await key('b', { metaKey: true });
    expect(composer.text()).toBe('**world**');
  });

  it.each(['d', 'q', 'k'])('does not intercept removed shortcut %s', async (value) => {
    select('hello');
    expect((await key(value, { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(composer.text()).toBe('hello');
  });

  it('leaves collapsed selections and IME composition alone', async () => {
    select('plain', 'plain', 2, 2);
    await key('b', { ctrlKey: true });
    expect(composer.text()).toBe('plain');
    select('plain');
    expect((await key('i', { ctrlKey: true, isComposing: true })).defaultPrevented).toBe(false);
    expect(composer.text()).toBe('plain');
  });
});
