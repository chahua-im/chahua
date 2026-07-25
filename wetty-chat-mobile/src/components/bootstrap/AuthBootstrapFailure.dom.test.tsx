import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';

vi.mock('@ionic/react', () => ({
  IonApp: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  IonPage: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  IonContent: ({ children, ...props }: { children: React.ReactNode }) => React.createElement('main', props, children),
  IonButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', props, props.children),
}));
import AuthBootstrapFailure from './AuthBootstrapFailure';

vi.stubGlobal('__AUTH_REDIRECT_URL__', null);

describe('AuthBootstrapFailure', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    i18n.activate('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('renders localized transient recovery with an enabled retry', async () => {
    const onRetry = vi.fn();
    await act(async () => {
      root.render(<AuthBootstrapFailure mode="transient" retrying={false} onRetry={onRetry} />);
    });

    expect(container.textContent).toContain('The app couldn’t refresh your session.');
    expect(container.textContent).toContain('Retry');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The app couldn’t refresh your session.');
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    button?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables retry and exposes busy status while retrying signed-out recovery', async () => {
    await act(async () => {
      root.render(<AuthBootstrapFailure mode="signed-out" retrying onRetry={vi.fn()} />);
    });

    expect(container.textContent).toContain('Your session is no longer available.');
    expect(container.textContent).toContain('Sign-in is not configured for this app build.');
    expect(container.textContent).toContain('Retrying…');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
