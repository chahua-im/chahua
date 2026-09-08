import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FormatToolbar } from './FormatToolbar';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));
vi.mock('@ionic/react', () => ({
  IonIcon: () => null,
}));
vi.mock('ionicons/icons', () => ({
  linkOutline: 'link-outline',
}));
vi.mock('./FormatToolbar.module.scss', () => ({ default: {} }));

let container: HTMLDivElement;
let root: Root;
let onFormat: Mock<(kind: 'bold' | 'italic' | 'strike' | 'underline' | 'code' | 'quote') => void>;
let onSubmitLink: Mock<(url: string) => void>;
let onRequestLinkMode: Mock<(open: boolean) => void>;

const anchor = { top: 120, left: 300 };

function click(target: Element, eventInit: MouseEventInit = {}) {
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...eventInit }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...eventInit }));
  });
}

function render(linkMode = false) {
  act(() => {
    root.render(
      <FormatToolbar
        anchor={anchor}
        linkMode={linkMode}
        onRequestLinkMode={onRequestLinkMode}
        onFormat={onFormat}
        onSubmitLink={onSubmitLink}
      />,
    );
  });
}

function typeText(input: HTMLInputElement, value: string) {
  // Mirrors the native value setter trick used for controlled inputs.
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  onFormat = vi.fn();
  onSubmitLink = vi.fn();
  onRequestLinkMode = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('FormatToolbar', () => {
  it('renders all seven formatting buttons', () => {
    render();

    expect(container.querySelector('[data-format-bold]')).toBeTruthy();
    expect(container.querySelector('[data-format-italic]')).toBeTruthy();
    expect(container.querySelector('[data-format-strike]')).toBeTruthy();
    expect(container.querySelector('[data-format-underline]')).toBeTruthy();
    expect(container.querySelector('[data-format-code]')).toBeTruthy();
    expect(container.querySelector('[data-format-quote]')).toBeTruthy();
    expect(container.querySelector('[data-format-link]')).toBeTruthy();
    expect(container.querySelector('[data-format-url-popup]')).toBeNull();
  });

  it('keeps textarea selection alive: mousedown on any button does not steal focus', () => {
    render();
    const bold = container.querySelector('[data-format-bold]')!;

    let defaultPrevented = false;
    act(() => {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      defaultPrevented = !bold.dispatchEvent(event);
    });

    // preventDefault on mousedown is what stops the textarea from blurring.
    expect(defaultPrevented).toBe(true);
  });

  it('opens the URL popup via the link button', () => {
    render();

    click(container.querySelector('[data-format-link]')!);
    expect(onRequestLinkMode).toHaveBeenCalledWith(true);
  });

  it('submits a typed URL and ignores empty input', () => {
    render(true);

    const input = container.querySelector('[data-format-url-input]')! as HTMLInputElement;
    const apply = container.querySelector('[data-format-url-apply]')!;

    typeText(input, 'example.com/path');
    click(apply);
    expect(onSubmitLink).toHaveBeenCalledWith('example.com/path');
    expect(onRequestLinkMode).toHaveBeenCalledWith(false);

    onSubmitLink.mockClear();
    onRequestLinkMode.mockClear();
    typeText(input, '   ');
    click(apply);
    expect(onSubmitLink).not.toHaveBeenCalled();
  });

  it('cancels link mode on Escape', () => {
    render(true);
    const input = container.querySelector('[data-format-url-input]')! as HTMLInputElement;

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(onRequestLinkMode).toHaveBeenCalledWith(false);
  });
});
