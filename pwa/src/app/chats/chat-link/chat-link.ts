import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  linkedSignal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { createAnimation, IonModal } from '@ionic/angular';
import { fromEvent, map } from 'rxjs';
import { PanelNavigation, panelIdentity } from '../../navigation/panel-navigation';
import { PanelPage } from '../../navigation/panel-page';
import { panelDefinition, PanelKind } from '../../navigation/panel-definitions';
import { panelModalSlide, panelSlide } from '../../navigation/panel-animation';
import { SidebarFrame } from '../../layout/sidebar-frame';

type PanelPresentation = { paths: string[]; sidebar: boolean };

/** Route-owned panels and a separate media overlay retain their underlying pages. */
@Component({
  selector: 'app-chat-link',
  imports: [IonModal, PanelPage, SidebarFrame],
  styles: `
    .panel-layer {
      position: absolute;
      inset: 0;
      background: var(--ion-background-color);
    }
    .panel-layer.inactive {
      pointer-events: none;
    }
  `,
  template: `
    <ion-modal
      #panelModal
      class="route-panel"
      [class.panel-sidebar]="displayed().sidebar"
      [class.panel-page]="!largeScreen() && !sheet()"
      [enterAnimation]="panelEnter"
      [leaveAnimation]="panelLeave"
      [keepContentsMounted]="true"
      (didDismiss)="clearClosed()"
      [showBackdrop]="!displayed().sidebar"
      [focusTrap]="!displayed().sidebar"
      [canDismiss]="canDismiss"
    >
      <ng-template>
        <app-sidebar-frame [docked]="displayed().sidebar" [overlay]="true">
          @for (path of rendered().paths; track identity(path)) {
            <div
              #panelPage
              class="panel-layer"
              [attr.data-panel]="identity(path)"
              [hidden]="
                identity(path) !== identity(rendered().target.at(-1) ?? '') && identity(path) !== rendered().leaving
              "
              [class.inactive]="identity(path) !== identity(rendered().target.at(-1) ?? '')"
            >
              <app-panel-page
                [path]="path"
                [source]="source()"
                [active]="identity(path) === identity(rendered().target.at(-1) ?? '') && !panels.media()"
              />
            </div>
          }
        </app-sidebar-frame>
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
  protected readonly sheet = computed(() => {
    const kind = panelDefinition(this.displayed().paths[0] ?? '')?.kind;
    return kind === PanelKind.Create || kind === PanelKind.AddFriend || kind === PanelKind.Join;
  });
  protected readonly panelEnter = (element: HTMLElement) => this.panelAnimation(element, true);
  protected readonly panelLeave = (element: HTMLElement) => this.panelAnimation(element, false);
  private panelAnimation(element: HTMLElement, entering: boolean) {
    const animation = this.displayed().sidebar
      ? entering
        ? SidebarFrame.enterModal(element)
        : SidebarFrame.leaveModal(element)
      : panelModalSlide(element, entering, this.largeScreen() || this.sheet());
    return this.panels.nativeTransition() ? animation.duration(0) : animation;
  }
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
  protected readonly rendered = linkedSignal<string[], { target: string[]; paths: string[]; leaving?: string }>({
    source: () => this.displayed().paths,
    computation: (target, previous) => {
      const from = previous?.source.at(-1);
      const leaving =
        from && panelIdentity(from) !== panelIdentity(target.at(-1) ?? '') ? panelIdentity(from) : undefined;
      const paths =
        from && leaving && !target.some((path) => panelIdentity(path) === leaving) ? [...target, from] : target;
      return { target, paths, leaving };
    },
  });
  private readonly pageElements = viewChildren<ElementRef<HTMLElement>>('panelPage');
  private readonly wide = window.matchMedia('(min-width: 1200px)');
  private readonly modal = viewChild<IonModal>('panelModal');
  private readonly mediaModal = viewChild<IonModal>('mediaModal');
  private transition = Promise.resolve();
  protected readonly largeScreen = toSignal(
    fromEvent<MediaQueryListEvent>(this.wide, 'change').pipe(map((event) => event.matches)),
    { initialValue: this.wide.matches },
  );
  constructor() {
    afterRenderEffect((onCleanup) => {
      const state = this.rendered();
      const elements = this.pageElements();
      if (!state.leaving) return;
      const finish = () => {
        if (this.rendered() === state) this.rendered.set({ target: state.target, paths: state.target });
      };
      const entering = elements.find(
        (item) => item.nativeElement.dataset['panel'] === panelIdentity(state.target.at(-1) ?? ''),
      )?.nativeElement;
      const leaving = elements.find((item) => item.nativeElement.dataset['panel'] === state.leaving)?.nativeElement;
      if (this.largeScreen() || this.panels.nativeTransition() || !entering || !leaving) {
        untracked(finish);
        return;
      }
      const backwards = this.panels.backwards();
      const animations = [panelSlide(entering, true, backwards), panelSlide(leaving, false, backwards)];
      onCleanup(() => {
        animations.forEach((animation) => animation.destroy());
        for (const element of [entering, leaving]) {
          for (const property of ['pointer-events', 'z-index', 'transform']) element.style.removeProperty(property);
        }
      });
      void Promise.all(animations.map((animation) => animation.play())).then(finish);
    });
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
      .duration(this.panels.nativeTransition() ? 0 : 180)
      .easing('ease-out')
      .beforeStyles({ transform: 'none' })
      .fromTo('opacity', entering ? '0' : '1', entering ? '1' : '0');
  }
  protected readonly canDismissMedia = () => {
    if (!this.panels.media()) return true;
    void this.panels.close();
    return false;
  };
  protected readonly canDismiss = (_data?: unknown, role?: string) => {
    if (!this.panelPaths().length) return true;
    void (role === 'escape' ? this.panels.back() : this.panels.close());
    return false;
  };
}
