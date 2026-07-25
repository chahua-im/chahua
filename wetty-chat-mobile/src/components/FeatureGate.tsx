import React from 'react';
import type { Feature } from '@/features';
import { useFeatureGate } from '@/hooks/useFeatureGate';

interface FeatureGateProps {
  feature: Feature;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  /** Additionally require a Vite development build, for dev-only backend contracts. */
  devOnly?: boolean;
}

export const FeatureGate: React.FC<FeatureGateProps> = ({ feature, children, fallback = null, devOnly = false }) => {
  const isEnabled = useFeatureGate(feature) && (!devOnly || import.meta.env.DEV);
  return isEnabled ? children : fallback;
};
