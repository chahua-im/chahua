import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-message-swipe-reply',
  template: `
    <svg viewBox="0 0 512 512">
      <path
        d="M240 424v-96c116.4 0 159.39 33.76 208 96 0-119.23-39.57-240-208-240V88L64 256Z"
        fill="none"
        stroke="currentColor"
        stroke-width="35"
        stroke-linejoin="round"
      />
      <path
        d="M240 424v-96c116.4 0 159.39 33.76 208 96 0-119.23-39.57-240-208-240V88L64 256Z"
        fill="currentColor"
        [style.clip-path]="'inset(0 0 0 ' + (1 - fillProgress()) * 100 + '%)'"
      />
    </svg>
  `,
  styles: `
    :host {
      position: absolute;
      grid-row: 1 / 2;
      right: 16px;
      top: 50%;
      width: 28px;
      height: 28px;
      color: var(--ion-color-primary);
      pointer-events: none;
    }
    svg {
      width: 100%;
      height: 100%;
    }
    :host(.burst) {
      animation: reply-burst 400ms ease-out;
    }
    @keyframes reply-burst {
      45% {
        transform: scale(1.25);
      }
    }
  `,
  host: {
    class: 'swipe-reply',
    '[style.translate]': "offset() + 'px -50%'",
    '[style.opacity]': 'progress()',
    '[style.scale]': '0.5 + progress() * 0.5',
    '[class.burst]': 'burst()',
    '(animationend)': 'animationCompleted.emit()',
  },
})
export class MessageSwipeReply {
  readonly offset = input(0);
  readonly progress = input(0);
  readonly fillProgress = input(0);
  readonly burst = input(false);
  readonly animationCompleted = output<void>();
}
