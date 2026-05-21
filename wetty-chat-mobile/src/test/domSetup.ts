import { afterEach, vi } from 'vitest';

const cacheStores = new Map<string, Map<string, Response>>();

vi.stubGlobal('caches', {
  async open(name: string) {
    if (!cacheStores.has(name)) {
      cacheStores.set(name, new Map());
    }
    const store = cacheStores.get(name)!;
    return {
      async put(key: string, response: Response) {
        store.set(key, response);
      },
      async match(key: string) {
        return store.get(key);
      },
    };
  },
  async delete(name: string) {
    return cacheStores.delete(name);
  },
});

afterEach(() => {
  document.cookie.split(';').forEach((cookie) => {
    const name = cookie.split('=')[0]?.trim();
    if (name) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  });
  cacheStores.clear();
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});
