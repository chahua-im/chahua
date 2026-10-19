import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { FormatToolbar } from './format-toolbar';

describe('FormatToolbar', () => {
  let fixture: ComponentFixture<FormatToolbar>;
  beforeEach(() => {
    fixture = TestBed.createComponent(FormatToolbar);
    fixture.componentRef.setInput('anchor', { top: 120, left: 300 });
    fixture.detectChanges();
  });

  function click(target: Element | null) {
    if (!target) throw new Error('missing toolbar element');
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  it('renders all six formatting buttons', () => {
    const element = fixture.nativeElement as HTMLElement;
    for (const kind of ['bold', 'italic', 'strike', 'code', 'quote', 'link']) {
      expect(element.querySelector(`[data-format-${kind}]`)).toBeTruthy();
    }
  });

  it('emits the clicked format kind', () => {
    const format = vi.fn();
    fixture.componentInstance.format.subscribe(format);
    click((fixture.nativeElement as HTMLElement).querySelector('[data-format-bold]'));
    expect(format).toHaveBeenCalledWith('bold');
  });

  it('prevents mousedown defaults so the textarea keeps its selection', () => {
    const element = fixture.nativeElement as HTMLElement;
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    element.querySelector('[data-format-toolbar]')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens the link popup, applies a typed URL and closes the popup', async () => {
    const submitLink = vi.fn();
    fixture.componentInstance.submitLink.subscribe(submitLink);
    const element = fixture.nativeElement as HTMLElement;

    click(element.querySelector('[data-format-link]'));
    expect(fixture.componentInstance.linkMode()).toBe(true);
    fixture.detectChanges();
    const input = element.querySelector('[data-format-url-input]') as HTMLInputElement;
    expect(input.value).toBe('https://');

    input.value = 'example.com/docs';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    click(element.querySelector('[data-format-url-apply]'));

    expect(submitLink).toHaveBeenCalledWith('example.com/docs');
    expect(fixture.componentInstance.linkMode()).toBe(false);
    await Promise.resolve();
  });

  it('closes the link popup with Escape and applies with Enter', () => {
    const submitLink = vi.fn();
    fixture.componentInstance.submitLink.subscribe(submitLink);
    fixture.componentInstance.linkMode.set(true);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector('[data-format-url-input]') as HTMLInputElement;

    input.value = 'example.com/a';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(fixture.componentInstance.linkMode()).toBe(false);
    expect(submitLink).not.toHaveBeenCalled();

    fixture.componentInstance.linkMode.set(true);
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(submitLink).toHaveBeenCalledWith('example.com/a');
  });
});
