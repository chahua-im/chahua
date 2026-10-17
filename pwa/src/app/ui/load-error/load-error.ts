import { booleanAttribute, Component, input, output } from '@angular/core';
import { IonButton, IonIcon } from '@ionic/angular';
import { alertCircleOutline } from 'ionicons/icons';

@Component({
  selector: 'app-load-error',
  imports: [IonButton, IonIcon],
  template: `
    <div class="load-error">
      <span class="icon"><ion-icon [icon]="icon" /></span>
      <p>{{ message() }}</p>
      @if (retryable()) {
        <ion-button fill="outline" size="small" (click)="retry.emit()">重试</ion-button>
      }
    </div>
  `,
  styleUrl: './load-error.scss',
  host: { '[class.compact]': 'compact()' },
})
export class LoadError {
  readonly message = input.required<string>();
  readonly compact = input(false, { transform: booleanAttribute });
  readonly retryable = input(true, { transform: booleanAttribute });
  readonly retry = output<void>();
  protected readonly icon = alertCircleOutline;
}
