// Test stand-in for "@lingui/react/macro" (see vitest.config.ts): `Trans`
// renders its children so source text shows through.
import type { ReactNode } from 'react';

export const Trans = ({ children }: { children?: ReactNode }) => children;
