import { TestBed } from '@angular/core/testing';
import { IonModal } from '@ionic/angular';
import { By } from '@angular/platform-browser';
import { StickerPackVisibility } from '../../../generated/models';
import { StickerEditor } from './sticker-editor';

describe('StickerEditor dismissal', () => {
  it('offers visibility only when editing a pack, and submits it with the name on save', () => {
    vi.spyOn(IonModal.prototype, 'isOpen', 'set').mockImplementation(() => {});
    const fixture = TestBed.createComponent(StickerEditor);
    fixture.componentRef.setInput('title', '编辑贴纸包');
    fixture.componentRef.setInput('initialName', '茶');
    fixture.componentRef.setInput('initialVisibility', StickerPackVisibility.public);
    fixture.detectChanges();
    fixture.debugElement.query(By.directive(IonModal)).nativeElement.dispatchEvent(new CustomEvent('ionMount'));
    fixture.detectChanges();
    const editor = fixture.componentInstance;
    const confirmed = vi.fn();
    editor.confirmed.subscribe(confirmed);
    expect(editor['unchanged']()).toBe(true);
    fixture.nativeElement
      .querySelector('ion-select')
      .dispatchEvent(new CustomEvent('ionChange', { detail: { value: StickerPackVisibility.private } }));
    expect(confirmed).not.toHaveBeenCalled();
    expect(editor['unchanged']()).toBe(false);
    editor['submit']();
    expect(confirmed).toHaveBeenCalledExactlyOnceWith({
      name: '茶',
      emoji: '',
      visibility: StickerPackVisibility.private,
    });
    fixture.componentRef.setInput('initialVisibility', undefined);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-select')).toBeNull();
    vi.restoreAllMocks();
  });
  it('validates whole emoji sequences rather than code points', () => {
    const fixture = TestBed.createComponent(StickerEditor);
    fixture.componentRef.setInput('title', '贴纸');
    fixture.componentRef.setInput('withEmoji', true);
    const editor = fixture.componentInstance;
    for (const emoji of ['👨‍👩‍👧‍👦', '👩🏽‍💻🇨🇳1️⃣👍🏿', ' 👍 ']) {
      editor['value'].set({ name: '', emoji });
      expect(editor['validEmoji']()).toBe(true);
    }
    for (const emoji of ['', 'hello🍵', '🍵 🍵', '🍵🍵🍵🍵🍵']) {
      editor['value'].set({ name: '', emoji });
      expect(editor['validEmoji']()).toBe(false);
    }
  });
  it('appends picked emoji to the editable field and closes the panel', () => {
    const fixture = TestBed.createComponent(StickerEditor);
    fixture.componentRef.setInput('title', '贴纸');
    fixture.componentRef.setInput('withEmoji', true);
    const editor = fixture.componentInstance;
    editor['openEmojiPicker']();
    expect(editor['choosingEmoji']()).toBe(true);
    editor['chooseEmoji']('🍵');
    editor['chooseEmoji']('🍰');
    expect(editor['value']().emoji).toBe('🍵🍰');
    expect(editor['choosingEmoji']()).toBe(false);
  });
  it('allows saved and navigation dismissal while blocking cancellation during a save', async () => {
    TestBed.overrideComponent(StickerEditor, {
      set: { template: '<ion-modal [canDismiss]="canDismiss" />' },
    });
    const fixture = TestBed.createComponent(StickerEditor);
    fixture.componentRef.setInput('title', '贴纸');
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    const modal: HTMLIonModalElement = fixture.nativeElement.querySelector('ion-modal');
    const canDismiss = modal.canDismiss as (_data?: unknown, role?: string) => Promise<boolean>;
    expect(await canDismiss()).toBe(false);
    expect(await canDismiss(undefined, 'backdrop')).toBe(false);
    for (const role of ['saved', 'navigate', 'parent-dismissed', 'parent-removed']) {
      expect(await canDismiss(undefined, role)).toBe(true);
    }
    modal.dismiss = vi.fn().mockResolvedValue(true);
    await fixture.componentInstance.dismiss();
    expect(modal.dismiss).toHaveBeenCalledWith(undefined, 'saved');
  });
});
