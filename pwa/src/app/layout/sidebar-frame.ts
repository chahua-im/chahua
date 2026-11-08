import { Component, input, type AnimationCallbackEvent } from '@angular/core';
import { createAnimation } from '@ionic/angular';

function slide(element: HTMLElement, entering: boolean) {
  return createAnimation()
    .addElement(element)
    .duration(200)
    .easing('ease-out')
    .beforeStyles({ opacity: '1' })
    .fromTo(
      'transform',
      entering ? 'translateX(100%)' : 'translateX(0)',
      entering ? 'translateX(0)' : 'translateX(100%)',
    );
}

/** Shared right-column surface; Ionic owns the lifecycle when hosted in a modal. */
@Component({
  selector: 'app-sidebar-frame',
  template: '<ng-content />',
  styleUrl: './sidebar-frame.scss',
  host: {
    '[class.docked]': 'docked()',
    '[class.overlay]': 'overlay()',
    '(animate.enter)': 'animate($event, true)',
    '(animate.leave)': 'animate($event, false)',
  },
})
export class SidebarFrame {
  readonly docked = input(false);
  readonly overlay = input(false);
  static readonly enterModal = (element: HTMLElement) =>
    slide(element.shadowRoot!.querySelector('.modal-wrapper')!, true);
  static readonly leaveModal = (element: HTMLElement) =>
    slide(element.shadowRoot!.querySelector('.modal-wrapper')!, false);
  private finishAnimation?: () => void;

  protected animate(event: AnimationCallbackEvent, entering: boolean) {
    this.finishAnimation?.();
    if (!this.docked() || this.overlay()) {
      event.animationComplete();
      return;
    }
    const animation = slide(event.target as HTMLElement, entering);
    this.finishAnimation = () => {
      animation.destroy();
      this.finishAnimation = undefined;
      event.animationComplete();
    };
    animation.onFinish(this.finishAnimation, { oneTimeCallback: true });
    void animation.play();
  }
}
