import { Component, computed, DestroyRef, effect, inject, input, output, signal } from '@angular/core';
import { AlertController, IonIcon, ToastController, type AlertButton } from '@ionic/angular';
import { alertCircleOutline } from 'ionicons/icons';
import { translateSignal } from '@jsverse/transloco';
import { AttachmentUploadPurpose } from '../../generated/models';
import { Diagnostics } from '../pwa/diagnostics';
import { Preferences } from '../settings/preferences';
import { type AttachmentUpload, UploadStatus } from './upload';
import { UploadErrorCode } from './upload-error';

enum FailureAction {
  Retry = 'retry',
  Delete = 'destructive',
}

type UploadState = ReturnType<AttachmentUpload['state']>;

const storageReasonKeys = new Map([
  ['AccessDenied', 'forbidden'],
  ['AccessControlListNotSupported', 'server'],
  ['IncompleteBody', 'storageIncomplete'],
  ['AuthorizationQueryParametersError', 'validationFailed'],
  ['InvalidSignature', 'validationFailed'],
  ['SignatureDoesNotMatch', 'validationFailed'],
  ['ExpiredToken', 'validationFailed'],
  ['RequestExpired', 'validationFailed'],
  ['RequestTimeTooSkewed', 'server'],
]);

const reasonKeys = new Map([
  [UploadErrorCode.StorageRejected, 'unknown'],
  [UploadErrorCode.Rejected, 'unknown'],
  [UploadErrorCode.Protocol, 'unknown'],
  [UploadErrorCode.TransferStalled, 'timeout'],
  [UploadErrorCode.StorageResponseTimeout, 'timeout'],
]);

const failuresWithDetails = [
  UploadErrorCode.Timeout,
  UploadErrorCode.TransferStalled,
  UploadErrorCode.StorageResponseTimeout,
  UploadErrorCode.Network,
  UploadErrorCode.RateLimited,
  UploadErrorCode.ProcessingTimeout,
  UploadErrorCode.ProcessingFailed,
  UploadErrorCode.Protocol,
  UploadErrorCode.Unknown,
];

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
  private readonly toasts = inject(ToastController);
  private readonly diagnostics = inject(Diagnostics);
  private readonly preferences = inject(Preferences);
  private readonly destroy = inject(DestroyRef);
  private readonly title = translateSignal('messages.upload.failedTitle');
  private readonly cancelLabel = translateSignal('common.cancel');
  private readonly retryLabel = translateSignal('common.retry');
  private readonly retryingLabel = translateSignal('messages.upload.retrying');
  private readonly deleteLabel = translateSignal('common.delete');
  private readonly copyLabel = translateSignal('messages.upload.copyError');
  private readonly copied = translateSignal('messages.upload.errorCopied');
  private readonly copyFailed = translateSignal('messages.upload.copyErrorFailed');
  private readonly copying = signal(false);
  private readonly reasonKey = computed(() => {
    const error = this.failure();
    if (error?.code === UploadErrorCode.StorageRejected) {
      const storage = error.storage;
      const reason = storage?.expired ? 'validationFailed' : storageReasonKeys.get(storage?.code ?? '');
      if (reason) return `messages.upload.${reason}`;
    }
    if (error?.code === UploadErrorCode.ProcessingTimeout || error?.code === UploadErrorCode.ProcessingFailed) {
      return this.upload().purpose === AttachmentUploadPurpose.file
        ? 'messages.upload.fileTypeFailed'
        : 'messages.upload.processingFailed';
    }
    const code = error?.code ?? UploadErrorCode.Unknown;
    return `messages.upload.${reasonKeys.get(code) ?? code}`;
  });
  private readonly reason = translateSignal(this.reasonKey);
  private readonly retryNote = translateSignal('messages.upload.autoRetry');
  private readonly message = computed(() =>
    this.failure()?.autoRetry ? `${this.reason()} ${this.retryNote()}` : this.reason(),
  );
  private readonly details = computed(() => {
    if (!this.preferences.showDiagnosticsOnError()) return;
    const error = this.failure();
    if (!error || (!error.storage && error.rpcCode == null && !failuresWithDetails.includes(error.code))) return;
    return this.upload().diagnosticDetails();
  });
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
        cssClass: 'upload-failure-dialog',
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

  private async copyErrorDetails() {
    const details = this.details();
    if (!details || this.destroyed || this.copying()) return;
    this.copying.set(true);
    let message: string;
    try {
      this.diagnostics.record('upload.report', details);
      await this.diagnostics.copy();
      message = this.copied();
    } catch {
      message = this.copyFailed();
    } finally {
      this.copying.set(false);
    }
    if (this.destroyed) return;
    const toast = await this.toasts.create({ message, duration: 3000, position: 'bottom' });
    await toast.present();
  }

  private buttons(state: UploadState): AlertButton[] {
    const error = state.error;
    if (!error) return [];
    const buttons: AlertButton[] = [{ text: this.cancelLabel(), role: 'cancel' }];
    if (this.details()) {
      buttons.push({
        text: this.copyLabel(),
        cssClass: 'upload-error-copy',
        htmlAttributes: { disabled: this.copying() },
        handler: () => {
          void this.copyErrorDetails();
          return false;
        },
      });
    }
    buttons.push({
      text: error.canRetry
        ? state.status === UploadStatus.Failed
          ? this.retryLabel()
          : this.retryingLabel()
        : this.deleteLabel(),
      role: error.canRetry ? FailureAction.Retry : FailureAction.Delete,
      htmlAttributes: { disabled: state.status !== UploadStatus.Failed },
    });
    return buttons;
  }
}
