import { IonApp, IonButton, IonContent, IonPage } from '@ionic/react';
import { i18n } from '@/i18n';
import styles from './AuthBootstrapFailure.module.scss';

type AuthBootstrapFailureMode = 'transient' | 'signed-out';

interface AuthBootstrapFailureProps {
  mode: AuthBootstrapFailureMode;
  retrying: boolean;
  onRetry: () => void;
}

export default function AuthBootstrapFailure({ mode, retrying, onRetry }: AuthBootstrapFailureProps) {
  const hasRedirect = typeof __AUTH_REDIRECT_URL__ === 'string' && __AUTH_REDIRECT_URL__.length > 0;
  const title =
    mode === 'transient'
      ? i18n._({ id: 'auth.bootstrap.transient.title', message: 'The app couldn’t refresh your session.' })
      : i18n._({ id: 'auth.bootstrap.signed-out.title', message: 'Your session is no longer available.' });
  const description =
    mode === 'signed-out'
      ? hasRedirect
        ? i18n._({
            id: 'auth.bootstrap.redirecting.description',
            message: 'Please wait while this app redirects you to sign in.',
          })
        : i18n._({
            id: 'auth.bootstrap.signed-out.description',
            message: 'Sign-in is not configured for this app build.',
          })
      : i18n._({ id: 'auth.bootstrap.transient.description', message: 'Check your connection and try again.' });

  return (
    <IonApp>
      <IonPage>
        <IonContent className={styles.content} fullscreen>
          <section
            className={styles.panel}
            role="alert"
            aria-labelledby="auth-bootstrap-title"
            aria-describedby="auth-bootstrap-description"
          >
            <h1 id="auth-bootstrap-title">{title}</h1>
            <p id="auth-bootstrap-description">{description}</p>
            <div role="status" aria-live="polite" className={styles.status}>
              {retrying ? i18n._({ id: 'auth.bootstrap.retrying', message: 'Retrying…' }) : ''}
            </div>
            <IonButton type="button" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
              {i18n._({ id: 'auth.bootstrap.retry', message: 'Retry' })}
            </IonButton>
          </section>
        </IonContent>
      </IonPage>
    </IonApp>
  );
}
