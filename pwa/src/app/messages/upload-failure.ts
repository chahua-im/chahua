import { Component, computed, DestroyRef, effect, inject, input, output } from '@angular/core';
import { AlertController, IonIcon, type AlertButton } from '@ionic/angular';
import { alertCircleOutline } from 'ionicons/icons';
import { translateSignal } from '@jsverse/transloco';
import { type AttachmentUpload, UploadStatus } from './upload';
import { UploadErrorCode } from './upload-error';

enum FailureAction {
  Retry = 'retry',
  Delete = 'destructive',
}

type UploadState = ReturnType<AttachmentUpload['state']>;

@Component({
  selector: 'app-upload-failure',
  imports: [IonIcon],
  template: `
    @if (failure()) {
      @if (upload().state().status === Status.Failed) {
        <button type="button" class="upload-failure" (pointerdown)="$event.stopPropagation()" (click)="show($event)">
          <ion-icon [icon]="icon" />
        </button>
      }
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .upload-failure {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: grid;
      place-items: center;
      width: 100%;
      padding: 0;
      border: 0;
      background: rgba(var(--ion-background-color-rgb), 0.55);
      color: var(--ion-color-danger);
      font-size: 28px;
      cursor: pointer;
    }
  `,
})
export class UploadFailure {
  readonly upload = input.required<AttachmentUpload>();
  readonly retry = output<void>();
  readonly remove = output<void>();
  protected readonly failure = computed(() => this.upload().state().error);
  protected readonly Status = UploadStatus;
  protected readonly icon = alertCircleOutline;
  private readonly alerts = inject(AlertController);
  private readonly destroy = inject(DestroyRef);
  private readonly title = translateSignal('messages.upload.failedTitle');
  private readonly cancelLabel = translateSignal('common.cancel');
  private readonly retryLabel = translateSignal('common.retry');
  private readonly retryingLabel = translateSignal('messages.upload.retrying');
  private readonly deleteLabel = translateSignal('common.delete');
  private readonly reasonKey = computed(() => {
    const error = this.upload().state().error;
    const code = error?.code ?? UploadErrorCode.Unknown;
    return `messages.upload.${code === UploadErrorCode.TooLarge && error?.maxSizeMiB == null ? 'tooLargeUnknown' : code}`;
  });
  private readonly reasonParams = computed(() => ({ limit: this.upload().state().error?.maxSizeMiB }), {
    equal: (a, b) => a.limit === b.limit,
  });
  private readonly reason = translateSignal(this.reasonKey, this.reasonParams);
  private readonly retryNoteKey = computed(
    () =>
      `messages.upload.${this.upload().state().error?.code === UploadErrorCode.Offline ? 'reconnect' : 'autoRetry'}`,
  );
  private readonly retryNote = translateSignal(this.retryNoteKey);
  protected readonly message = computed(() =>
    this.failure()?.autoRetry ? `${this.reason()} ${this.retryNote()}` : this.reason(),
  );
  private alert?: HTMLIonAlertElement;
  private alertContent = '';
  private opening = false;
  private destroyed = false;

  constructor() {
    effect(() => {
      const state = this.upload().state();
      const alert = this.alert;
      if (!state.error) {
        if (!alert) return;
        this.alert = undefined;
        void alert.dismiss();
        return;
      }
      // Track localized values while the error may be shown so an open alert follows language changes.
      const header = this.title();
      const message = this.message();
      const buttons = this.buttons(state);
      if (!alert) return;
      const content = JSON.stringify([header, message, buttons]);
      if (content === this.alertContent) return;
      this.alertContent = content;
      alert.header = header;
      alert.message = message;
      alert.buttons = buttons;
    });
    this.destroy.onDestroy(() => {
      this.destroyed = true;
      const alert = this.alert;
      this.alert = undefined;
      void alert?.dismiss();
    });
  }

  protected async show(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.opening || this.alert) return;
    this.opening = true;
    try {
      const state = this.upload().state();
      if (!state.error || state.status !== UploadStatus.Failed) return;
      const alert = await this.alerts.create({
        header: this.title(),
        subHeader: this.upload().file.name,
        message: this.message(),
        buttons: this.buttons(state),
      });
      if (this.destroyed || !this.upload().state().error) {
        alert.remove();
        return;
      }
      this.alert = alert;
      const dismissed = alert.onDidDismiss();
      await alert.present();
      const { role } = await dismissed;
      if (this.alert === alert) this.alert = undefined;
      if (this.destroyed) return;
      const current = this.upload().state();
      if (!current.error || current.status !== UploadStatus.Failed) return;
      if (role === FailureAction.Retry && current.error.canRetry) this.retry.emit();
      if (role === FailureAction.Delete && !current.error.canRetry) this.remove.emit();
    } finally {
      this.opening = false;
    }
  }

  private buttons(state: UploadState): AlertButton[] {
    const error = state.error;
    if (!error) return [];
    return [
      { text: this.cancelLabel(), role: 'cancel' },
      {
        text: error.canRetry
          ? state.status === UploadStatus.Failed
            ? this.retryLabel()
            : this.retryingLabel()
          : this.deleteLabel(),
        role: error.canRetry ? FailureAction.Retry : FailureAction.Delete,
        htmlAttributes: { disabled: state.status !== UploadStatus.Failed },
      },
    ];
  }
}
