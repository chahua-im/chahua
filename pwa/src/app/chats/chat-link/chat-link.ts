import { Component, computed, effect, inject, input, linkedSignal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { createAnimation, IonModal } from '@ionic/angular';
import { fromEvent, map } from 'rxjs';
import { PanelNavigation, panelIdentity } from '../../navigation/panel-navigation';
import { PanelPage } from '../../navigation/panel-page';
import { panelDefinition, PanelKind } from '../../navigation/panel-definitions';

type PanelPresentation = { paths: string[]; sidebar: boolean };

/** Route-owned panels and a separate media overlay retain their underlying pages. */
@Component({
  selector: 'app-chat-link',
  imports: [IonModal, PanelPage],
  template: `
    <ion-modal
      #panelModal
      class="route-panel"
      [class.panel-sidebar]="displayed().sidebar"
      [keepContentsMounted]="true"
      (didDismiss)="clearClosed()"
      [showBackdrop]="!displayed().sidebar"
      [focusTrap]="!displayed().sidebar"
      [canDismiss]="canDismiss"
    >
      <ng-template>
        @for (path of displayed().paths; track identity(path); let last = $last) {
          <app-panel-page [path]="path" [source]="source()" [active]="last && !panels.media()" [hidden]="!last" />
        }
      </ng-template>
    </ion-modal>
    <ion-modal
      #mediaModal
      class="route-panel media-viewer-overlay"
      [enterAnimation]="mediaEnter"
      [leaveAnimation]="mediaLeave"
      [keepContentsMounted]="true"
      [canDismiss]="canDismissMedia"
      (didDismiss)="clearClosedMedia()"
    >
      <ng-template>
        @if (displayedMedia(); as path) {
          <app-panel-page [path]="path" [source]="source()" [active]="panels.media()" />
        }
      </ng-template>
    </ion-modal>
  `,
})
export class ChatLink {
  readonly source = input<unknown>();
  protected readonly panels = inject(PanelNavigation);
  protected readonly identity = panelIdentity;
  protected readonly mediaEnter = (element: HTMLElement) => this.mediaAnimation(element, true);
  protected readonly mediaLeave = (element: HTMLElement) => this.mediaAnimation(element, false);
  private readonly panelPaths = computed(() =>
    this.panels.paths().filter((path) => panelDefinition(path)?.kind !== PanelKind.Media),
  );
  private readonly mediaPath = computed(() =>
    this.panels.paths().find((path) => panelDefinition(path)?.kind === PanelKind.Media),
  );
  protected readonly displayedMedia = linkedSignal<string | undefined, string | undefined>({
    source: this.mediaPath,
    computation: (next, previous) => next ?? previous?.value,
  });
  // Keep the visible content and dimensions intact until Ionic finishes closing.
  protected readonly displayed = linkedSignal<PanelPresentation, PanelPresentation>({
    source: () => ({
      paths: this.panelPaths(),
      sidebar:
        this.largeScreen() &&
        this.panelPaths().length === 1 &&
        panelDefinition(this.panelPaths()[0])?.kind === PanelKind.Info,
    }),
    computation: (next, previous) => (next.paths.length ? next : (previous?.value ?? next)),
  });
  private readonly wide = window.matchMedia('(min-width: 1200px)');
  private readonly modal = viewChild<IonModal>('panelModal');
  private readonly mediaModal = viewChild<IonModal>('mediaModal');
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
      const mediaModal = this.mediaModal();
      if (!modal || !mediaModal) return;
      // Serialize presentation and dismissal so fast Back/reopen cannot leave an empty modal.
      this.transition = this.transition.then(async () => {
        if (this.panelPaths().length) await modal.present();
        if (this.panels.media()) await mediaModal.present();
        else await mediaModal.dismiss();
        if (!this.panelPaths().length) await modal.dismiss();
      });
    });
  }
  protected clearClosed() {
    if (!this.panelPaths().length) this.displayed.set({ paths: [], sidebar: false });
  }
  protected clearClosedMedia() {
    if (!this.mediaPath()) this.displayedMedia.set(undefined);
  }
  private mediaAnimation(element: HTMLElement, entering: boolean) {
    return createAnimation()
      .addElement(element.shadowRoot!.querySelector('.modal-wrapper')!)
      .duration(180)
      .easing('ease-out')
      .beforeStyles({ transform: 'none' })
      .fromTo('opacity', entering ? '0' : '1', entering ? '1' : '0');
  }
  protected readonly canDismissMedia = () => {
    if (!this.panels.media()) return true;
    void this.panels.close();
    return false;
  };
  protected readonly canDismiss = () => {
    if (!this.panelPaths().length) return true;
    void this.panels.close();
    return false;
  };
}
