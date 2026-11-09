import * as fakeIndexedDB from 'fake-indexeddb';
import { vi } from 'vitest';

/** Install the native constructors used by idb's instanceof checks, with a fresh database factory. */
export function stubIndexedDB() {
  for (const [name, constructor] of Object.entries(fakeIndexedDB)) {
    if (name.startsWith('IDB')) vi.stubGlobal(name, constructor);
  }
  vi.stubGlobal('indexedDB', new fakeIndexedDB.IDBFactory());
}

/** Hold idb's next getAll result while allowing the native transaction to finish. */
export function delayNextGetAll() {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => (resolve = done));
  let resume: (() => void) | undefined;
  const getAll = fakeIndexedDB.IDBObjectStore.prototype.getAll;
  const reading = vi.spyOn(fakeIndexedDB.IDBObjectStore.prototype, 'getAll').mockImplementationOnce(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = getAll.apply(this, args);
    const listen = request.addEventListener.bind(request);
    vi.spyOn(request, 'addEventListener').mockImplementationOnce((type, listener, options) => {
      listen(
        type,
        (event) => {
          resume = () => {
            if (typeof listener === 'function') listener.call(request, event);
            else listener.handleEvent(event);
          };
          resolve();
        },
        options,
      );
    });
    return request;
  });
  return {
    ready,
    release() {
      resume?.();
      resume = undefined;
    },
    restore() {
      reading.mockRestore();
    },
  };
}
