import { ChatVirtualScroll as ChatVirtualScrollImpl } from './ChatVirtualScroll';
import { ChatVirtualScroll as ChatVirtualScrollLegacy } from '../virtualScroll.legacy/ChatVirtualScroll';
import type { ChatVirtualScrollProps } from './types';

/**
 * Decide which virtual-scroll variant to render.
 *
 * Dev: toggle via the browser console, then reload:
 *   localStorage.setItem('vscroll', 'legacy')   // use legacy (Fenwick) variant
 *   localStorage.setItem('vscroll', 'new')       // use new (full-render) variant
 *   localStorage.removeItem('vscroll')           // same as 'new'
 *   location.reload()
 *
 * Prod: hard-coded to 'new'; `import.meta.env.DEV` is false at build time so
 * the legacy branch is tree-shaken out of production bundles.
 *
 * The legacy variant is fully self-contained (its own types.ts / useChatRows.ts
 * with no cross-directory imports) so it can be bug-fixed on its own branch
 * without touching the new variant. The two variants expose structurally
 * equivalent `ChatVirtualScrollProps` contracts, so the dispatcher is a
 * transparent drop-in for consumers. Mirrors the localStorage + DEV-gate
 * pattern used by timelineDiagnostics.
 */
function useVirtualScrollVariant(): 'new' | 'legacy' {
  if (import.meta.env.DEV && typeof localStorage !== 'undefined') {
    return localStorage.getItem('vscroll') === 'legacy' ? 'legacy' : 'new';
  }
  return 'new';
}

export function ChatVirtualScroll(props: ChatVirtualScrollProps) {
  const variant = useVirtualScrollVariant();
  return variant === 'legacy' ? <ChatVirtualScrollLegacy {...props} /> : <ChatVirtualScrollImpl {...props} />;
}
