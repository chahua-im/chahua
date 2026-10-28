import { TestBed } from '@angular/core/testing';
import { IonRouterOutlet, NavController } from '@ionic/angular';
import { PageBack } from './page-back';

describe('Reading page Back', () => {
  it.each([true, false])('uses history when a previous Ionic page exists: %s', (canGoBack) => {
    const nav = { back: vi.fn(), navigateBack: vi.fn().mockResolvedValue(true) };
    TestBed.configureTestingModule({
      providers: [
        { provide: IonRouterOutlet, useValue: { canGoBack: () => canGoBack } },
        { provide: NavController, useValue: nav },
      ],
    });
    const fixture = TestBed.createComponent(PageBack);
    fixture.componentRef.setInput('fallback', '/chats');
    fixture.detectChanges();
    fixture.nativeElement.querySelector('ion-button').click();
    if (canGoBack) {
      expect(nav.back).toHaveBeenCalledOnce();
      expect(nav.navigateBack).not.toHaveBeenCalled();
    } else {
      expect(nav.navigateBack).toHaveBeenCalledWith('/chats', { replaceUrl: true });
      expect(nav.back).not.toHaveBeenCalled();
    }
  });
});
