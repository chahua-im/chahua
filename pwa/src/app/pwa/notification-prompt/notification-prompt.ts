import { Component, inject, signal, TemplateRef, viewChild, ViewContainerRef, ViewEncapsulation } from '@angular/core';
import { IonAlert, IonSpinner, IonToast } from '@ionic/angular';
import { PushNotifications } from '../push-notifications';

@Component({
  selector: 'app-notification-prompt',
  templateUrl: './notification-prompt.html',
  styleUrl: './notification-prompt.scss',
  encapsulation: ViewEncapsulation.None,
  imports: [IonAlert, IonSpinner, IonToast],
})
export class NotificationPrompt {
  private readonly notifications = inject(PushNotifications);
  private readonly views = inject(ViewContainerRef);
  private readonly spinner = viewChild.required<TemplateRef<unknown>>('spinner');
  protected readonly open = signal(this.notifications.shouldPrompt());
  protected readonly requesting = signal(false);
  private readonly toast = viewChild.required(IonToast);

  protected attachSpinner(event: Event) {
    const button = (event.target as HTMLElement).querySelector('.notification-allow')!;
    const view = this.views.createEmbeddedView(this.spinner());
    button.append(...view.rootNodes);
  }

  protected readonly decline = () => {
    if (this.requesting()) return false;
    this.notifications.declinePermission();
    this.open.set(false);
    return false;
  };

  protected readonly allow = async () => {
    if (this.requesting()) return false;
    this.requesting.set(true);
    try {
      const enabled = await this.notifications.setEnabled(true);
      await this.toast().dismiss();
      if (enabled) this.open.set(false);
      else await this.toast().present();
    } finally {
      this.requesting.set(false);
    }
    return false;
  };
}
