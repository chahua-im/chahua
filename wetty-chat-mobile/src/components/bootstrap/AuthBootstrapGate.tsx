import { useState } from 'react';
import { bootstrapAuth, type AuthBootstrapResult } from '@/authBootstrap';
import AuthBootstrapFailure from './AuthBootstrapFailure';

interface AuthBootstrapGateProps {
  initialResult: Exclude<AuthBootstrapResult, { status: 'ready' }>;
  onReady: () => void;
  onRedirecting: () => void;
}

export default function AuthBootstrapGate({ initialResult, onReady, onRedirecting }: AuthBootstrapGateProps) {
  const [retrying, setRetrying] = useState(false);
  const [mode, setMode] = useState<'transient' | 'signed-out'>(
    initialResult.status === 'signed-out' ? 'signed-out' : 'transient',
  );

  const retry = async () => {
    setRetrying(true);
    const result = await bootstrapAuth();
    if (result.status === 'ready') {
      onReady();
    } else if (result.status === 'redirecting') {
      onRedirecting();
    } else {
      setMode(result.status === 'signed-out' ? 'signed-out' : 'transient');
      setRetrying(false);
    }
  };

  return <AuthBootstrapFailure mode={mode} retrying={retrying} onRetry={() => void retry()} />;
}
