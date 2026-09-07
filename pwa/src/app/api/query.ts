import { signal, type DestroyRef } from '@angular/core';
import { Subject, type Observable } from 'rxjs';

/** Shared snapshot lifecycle; callers own the request and its domain data. */
export function activeQuery<T>(destroyRef: DestroyRef, request: (cancel: Observable<void>) => Promise<T>, initial: T) {
  const value = signal(initial);
  const loading = signal(false);
  const error = signal(false);
  const cancel = new Subject<void>();
  const consumers = new Set<symbol>();
  let dirty = true;
  let version = 0;
  let pending: Promise<void> | undefined;

  const start = (): Promise<void> => {
    if (destroyRef.destroyed || !consumers.size || !dirty) return Promise.resolve();
    loading.set(true);
    if (pending) return pending;
    pending = (async () => {
      await Promise.resolve();
      while (!destroyRef.destroyed && consumers.size && dirty) {
        const requestedVersion = version;
        const isCurrent = () => requestedVersion === version;
        error.set(false);
        try {
          const next = await request(cancel);
          if (!isCurrent()) continue;
          value.set(next);
          dirty = false;
        } catch {
          if (!isCurrent()) continue;
          error.set(true);
          return;
        }
      }
    })().finally(() => {
      pending = undefined;
      loading.set(false);
    });
    return pending;
  };

  destroyRef.onDestroy(() => {
    version++;
    cancel.next();
    cancel.complete();
  });

  return {
    value: value.asReadonly(),
    loading: loading.asReadonly(),
    error: error.asReadonly(),
    activate: () => {
      const consumer = Symbol();
      consumers.add(consumer);
      void start();
      return () => {
        consumers.delete(consumer);
        if (!consumers.size) {
          version++;
          loading.set(false);
          error.set(false);
          cancel.next();
        }
      };
    },
    refresh: () => {
      dirty = true;
      version++;
      return start();
    },
  };
}

export interface QueryPage<T, Cursor> {
  items: T[];
  cursor?: Cursor;
}

/** Read from the first page through the loaded item count. */
export async function readPages<T, Cursor>(
  read: (cursor?: Cursor) => Promise<QueryPage<T, Cursor>>,
  count: number,
  isCurrent: () => boolean,
): Promise<QueryPage<T, Cursor>> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor != null && items.length < count && isCurrent());
  return { items, cursor };
}
