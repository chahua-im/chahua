import { TestBed } from '@angular/core/testing';
import { EscapeNavigation, EscapePriority } from './escape-navigation';

describe('Escape layer ownership', () => {
  let escape: EscapeNavigation;
  let root: HTMLElement;
  const press = async (options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options });
    (document.activeElement ?? document).dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return event;
  };
  const overlay = (tag = 'ion-modal') => {
    const element = document.createElement(tag) as HTMLIonModalElement;
    root.append(element);
    element.overlayIndex = 1;
    element.backdropDismiss = true;
    element.dismiss = vi.fn().mockResolvedValue(true);
    element.classList.remove('overlay-hidden');
    return element;
  };
  beforeEach(() => {
    escape = TestBed.inject(EscapeNavigation);
    root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => root.remove());

  it('closes a sidebar before conversation state regardless of focused input', async () => {
    const input = document.createElement('input');
    root.append(input);
    input.focus();
    const conversation = vi.fn(() => true);
    const sidebar = vi.fn(() => true);
    escape.register(root, conversation, EscapePriority.Conversation);
    escape.register(root, sidebar, EscapePriority.Sidebar);
    await press();
    expect(sidebar).toHaveBeenCalledOnce();
    expect(conversation).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it('dismisses a popover above selection without reaching a second key listener', async () => {
    const selection = vi.fn(() => true);
    escape.register(root, selection, EscapePriority.Conversation);
    const menu = overlay('ion-popover');
    const downstream = vi.fn();
    root.addEventListener('keydown', downstream);
    await press();
    expect(menu.dismiss).toHaveBeenCalledExactlyOnceWith(undefined, 'backdrop');
    expect(selection).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });

  it.each([false, true])('handles an attachment menu beside a sidebar (blocking alert: %s)', async (blocked) => {
    const sidebar = overlay();
    sidebar.classList.add('panel-sidebar');
    const menu = document.createElement('div');
    menu.setAttribute('popover', 'auto');
    menu.hidePopover = vi.fn();
    root.append(menu);
    // jsdom does not expose the browser top layer.
    const query = document.querySelectorAll.bind(document);
    const querySpy = vi
      .spyOn(document, 'querySelectorAll')
      .mockImplementation((selector: string) =>
        selector === '[popover="auto"]:popover-open' ? ([menu] as unknown as NodeListOf<Element>) : query(selector),
      );
    try {
      const alert = blocked ? overlay('ion-alert') : undefined;
      await press();
      expect(sidebar.dismiss).not.toHaveBeenCalled();
      if (alert) {
        expect(menu.hidePopover).not.toHaveBeenCalled();
        expect(alert.dismiss).toHaveBeenCalledWith(undefined, 'backdrop');
      } else expect(menu.hidePopover).toHaveBeenCalledOnce();
    } finally {
      querySpy.mockRestore();
    }
  });

  it('allows an edit inside the top panel to consume Escape without dismissing it', async () => {
    const panel = overlay();
    const editor = document.createElement('div');
    panel.append(editor);
    const edit = vi.fn(() => true);
    escape.register(editor, edit, EscapePriority.Conversation);
    await press();
    expect(edit).toHaveBeenCalledOnce();
    expect(panel.dismiss).not.toHaveBeenCalled();
  });

  it('ignores hidden panel pages and dismisses only the visible panel', async () => {
    const panel = overlay();
    const hidden = document.createElement('div');
    hidden.hidden = true;
    panel.append(hidden);
    const edit = vi.fn(() => true);
    escape.register(hidden, edit, EscapePriority.Conversation);
    await press();
    expect(edit).not.toHaveBeenCalled();
    expect(panel.dismiss).toHaveBeenCalledExactlyOnceWith(undefined, 'escape');
  });

  it('ignores Toasts even above another overlay', async () => {
    const panel = overlay();
    overlay('ion-toast');
    await press();
    expect(panel.dismiss).toHaveBeenCalledExactlyOnceWith(undefined, 'escape');
  });

  it('does not bypass an overlay that cannot be dismissed', async () => {
    const fallback = vi.fn(() => true);
    escape.register(root, fallback, EscapePriority.Navigation);
    const alert = overlay('ion-alert');
    alert.backdropDismiss = false;
    await press();
    expect(alert.dismiss).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('lets a discard confirmation cancel a pending edit exit without repeating that exit', async () => {
    const panel = overlay();
    const editor = document.createElement('div');
    panel.append(editor);
    let finish!: (handled: boolean) => void;
    const edit = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    escape.register(editor, edit, EscapePriority.Conversation);
    await press();
    await press();
    expect(edit).toHaveBeenCalledOnce();
    const confirmation = overlay('ion-alert');
    await press();
    expect(confirmation.dismiss).toHaveBeenCalledExactlyOnceWith(undefined, 'backdrop');
    finish(true);
    await Promise.resolve();
    expect(panel.dismiss).not.toHaveBeenCalled();
  });

  it('ignores held keys and leaves IME and fullscreen Escape to the browser', async () => {
    const handler = vi.fn(() => true);
    escape.register(root, handler, EscapePriority.Navigation);
    expect((await press({ repeat: true })).defaultPrevented).toBe(true);
    expect((await press({ isComposing: true })).defaultPrevented).toBe(false);
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: root });
    try {
      expect((await press()).defaultPrevented).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(document, 'fullscreenElement', descriptor);
      else Reflect.deleteProperty(document, 'fullscreenElement');
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
