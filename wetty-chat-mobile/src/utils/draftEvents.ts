type DraftChangeListener = (draftKey: string) => void;

const listeners = new Set<DraftChangeListener>();

export function onDraftChange(fn: DraftChangeListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyDraftChange(draftKey: string): void {
  for (const fn of listeners) {
    fn(draftKey);
  }
}
