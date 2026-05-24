export function isPageHidden(): boolean {
  if (document.visibilityState !== 'visible') return true;
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
  return false;
}

export function getOverlayPortalTarget(): Element {
  return document.querySelector('ion-app') || document.body;
}
