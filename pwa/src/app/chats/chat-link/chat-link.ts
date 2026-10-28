import { Component, effect, inject, input, linkedSignal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { IonModal } from '@ionic/angular';
import { fromEvent, map } from 'rxjs';
import { PanelNavigation, panelIdentity } from '../../navigation/panel-navigation';
import { PanelPage } from '../../navigation/panel-page';

type PanelPresentation = { paths: string[]; sidebar: boolean; media: boolean };

/** One container for a route-owned panel flow; primary pages never leave their outlet. */
@Component({
  selector: 'app-chat-link',
  imports: [IonModal, PanelPage],
  template: `
    <ion-modal
      class="route-panel"
      [class.panel-sidebar]="displayed().sidebar"
      [class.media-viewer-overlay]="displayed().media"
      [keepContentsMounted]="true"
      (didDismiss)="clearClosed()"
      [showBackdrop]="!displayed().sidebar"
      [focusTrap]="!displayed().sidebar"
      [canDismiss]="canDismiss"
    >
      <ng-template>
        @for (path of displayed().paths; track identity(path); let last = $last) {
          <app-panel-page [path]="path" [source]="source()" [active]="last" [hidden]="!last" />
        }
      </ng-template>
    </ion-modal>
  `,
})
export class ChatLink {
  readonly source = input<unknown>();
  protected readonly panels = inject(PanelNavigation);
  protected readonly identity = panelIdentity;
  // Keep the visible content and dimensions intact until Ionic finishes closing.
  protected readonly displayed = linkedSignal<PanelPresentation, PanelPresentation>({
    source: () => ({ paths: this.panels.paths(), sidebar: this.panels.sidebar(), media: this.panels.media() }),
    computation: (next, previous) => (next.paths.length ? next : (previous?.value ?? next)),
  });
  private readonly wide = window.matchMedia('(min-width: 1200px)');
  private readonly modal = viewChild(IonModal);
  private transition = Promise.resolve();
  private readonly largeScreen = toSignal(
    fromEvent<MediaQueryListEvent>(this.wide, 'change').pipe(map((event) => event.matches)),
    { initialValue: this.wide.matches },
  );
  constructor() {
    effect(() => this.panels.largeScreen.set(this.largeScreen()));
    effect(() => {
      this.panels.paths();
      const modal = this.modal();
      if (!modal) return;
      // Serialize presentation and dismissal so fast Back/reopen cannot leave an empty modal.
      this.transition = this.transition.then(async () => {
        if (this.panels.paths().length) await modal.present();
        else await modal.dismiss();
      });
    });
  }
  protected clearClosed() {
    if (!this.panels.paths().length) this.displayed.set({ paths: [], sidebar: false, media: false });
  }
  protected readonly canDismiss = () => {
    if (!this.panels.paths().length) return true;
    void this.panels.close();
    return false;
  };
}
