import { TestBed } from '@angular/core/testing';
import { StickerEditor } from './sticker-editor';

describe('StickerEditor dismissal', () => {
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
