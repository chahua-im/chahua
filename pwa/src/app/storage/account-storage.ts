import { DestroyRef, inject, Service, signal, type WritableSignal } from '@angular/core';
import { openDB } from 'idb';
import { CHAHUA_BASE_URL } from '../../generated/endpoints/chahua.base-url';
import { migrateAccountStorage, readLegacyDrafts } from './account-storage-migration';
import {
  ACCOUNT_DATABASE,
  AccountStore,
  type AccountData,
  type AccountDatabase,
  type AccountDatabaseSchema,
  type AccountScope,
} from './account-database';
export { AccountStore } from './account-database';

type AccountValues = { [Store in AccountStore]: Partial<AccountData[Store]> };
const emptyValues = (): AccountValues => ({ preferences: {}, usage: {}, drafts: {} });

/** Only existing account preferences, usage and drafts; server data stays in memory. */
@Service()
export class AccountStorage {
  private readonly environment = new URL(inject(CHAHUA_BASE_URL) || '/_api', location.origin).href.replace(/\/$/, '');
  private database?: Promise<AccountDatabase>;
  private connection?: AccountDatabase;
  private scope?: AccountScope;
  private generation = 0;
  private readonly values: { [Store in AccountStore]: WritableSignal<AccountValues[Store]> } = {
    preferences: signal({}),
    usage: signal({}),
    drafts: signal({}),
  };
  private writes: Promise<void> = Promise.resolve();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.deactivate();
      void this.writes.then(() => this.database?.then((db) => db.close())).catch(() => {});
    });
  }

  read<
    Store extends AccountStore,
    Key extends keyof AccountData[Store] & string,
    Fallback extends AccountData[Store][Key] | null | undefined,
  >(store: Store, key: Key, fallback: Fallback): AccountData[Store][Key] | Fallback {
    return (this.values[store]()[key] as AccountData[Store][Key] | undefined) ?? fallback;
  }

  entries<Store extends AccountStore>(store: Store): Readonly<AccountValues[Store]> {
    return this.values[store]();
  }

  set<Store extends AccountStore, Key extends keyof AccountData[Store] & string>(
    store: Store,
    key: Key,
    value: NoInfer<AccountData[Store][Key]> | undefined,
  ) {
    this.values[store].update((current) => {
      const entries = { ...current };
      if (value === undefined) delete entries[key];
      else entries[key] = value;
      return entries;
    });
    const scope = this.scope;
    if (!scope) return;
    // Capture the owner now. Switching accounts must not redirect a pending write.
    const persist = async (db: AccountDatabase) => {
      const transaction = db.transaction(store, 'readwrite');
      const target = transaction.objectStore(store);
      try {
        const request =
          value === undefined
            ? target.delete([...scope, key])
            : target.put({ environment: scope[0], uid: scope[1], key, value });
        await Promise.all([request, transaction.done]);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* It may already have aborted. */
        }
        await transaction.done.catch(() => {});
        throw error;
      }
    };
    // Submit immediately on pagehide; don't wait for a promise queue to open the transaction.
    let writing: Promise<void>;
    try {
      writing = this.connection ? persist(this.connection) : this.open().then(persist);
    } catch {
      writing = Promise.resolve();
    }
    this.writes = Promise.all([
      this.writes,
      writing.catch(() => {
        // Keep the in-memory edit when storage is unavailable or full.
      }),
    ]).then(() => {});
  }

  /** Called with a server-confirmed UID before SessionStore publishes the user. */
  async activate(uid: number) {
    if (this.scope?.[1] === uid) return;
    this.deactivate();
    const generation = this.generation;
    const scope: AccountScope = [this.environment, uid];
    let values = emptyValues();
    try {
      await this.writes;
      if (generation !== this.generation) return;
      const db = await this.open();
      if (generation !== this.generation) return;
      // A failed migration must not hide data already in the new database.
      const migrated = await migrateAccountStorage(db, scope).then(
        () => true,
        () => false,
      );
      values = await this.load(db, scope);
      if (!migrated) {
        for (const [key, draft] of Object.entries(readLegacyDrafts(uid))) {
          const saved = values.drafts[key];
          if (!saved || saved.savedAt < draft.savedAt) values.drafts[key] = draft;
        }
      }
    } catch {
      // Do not assign global usage to an account unless its migration can commit.
      // UID-scoped drafts remain recoverable even if IndexedDB is unavailable.
      values.drafts = readLegacyDrafts(uid);
    }
    if (generation !== this.generation) return;
    this.scope = scope;
    this.replaceValues(values);
  }

  /** Release the active account's memory; retain its persisted data and pending writes. */
  deactivate() {
    this.generation++;
    this.scope = undefined;
    this.replaceValues(emptyValues());
  }

  /** Also lets callers finish outstanding writes before closing the database. */
  settled() {
    return this.writes;
  }

  private replaceValues(values: AccountValues) {
    this.values.preferences.set(values.preferences);
    this.values.usage.set(values.usage);
    this.values.drafts.set(values.drafts);
  }

  private async load(db: AccountDatabase, scope: AccountScope): Promise<AccountValues> {
    const transaction = db.transaction(Object.values(AccountStore), 'readonly');
    const range = IDBKeyRange.bound(scope, [...scope, []]);
    const [, stores] = await Promise.all([
      transaction.done,
      Promise.all(
        Object.values(AccountStore).map(async (name) => {
          const entries = await transaction.objectStore(name).getAll(range);
          return [name, Object.fromEntries(entries.map(({ key, value }) => [key, value]))] as const;
        }),
      ),
    ]);
    return Object.fromEntries(stores) as AccountValues;
  }

  private open() {
    if (this.database) return this.database;
    const disconnected = () => {
      this.database = undefined;
      this.connection = undefined;
    };
    return (this.database = openDB<AccountDatabaseSchema>(ACCOUNT_DATABASE, 1, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        // openDB reports creation failures; also observe the upgrade transaction's rejection.
        void transaction.done.catch(() => {});
        for (const store of Object.values(AccountStore)) {
          db.createObjectStore(store, { keyPath: ['environment', 'uid', 'key'] });
        }
        db.createObjectStore('meta', { keyPath: 'key' });
      },
      blocking: () => {
        this.connection?.close();
        disconnected();
      },
      terminated: disconnected,
    })
      .then((db) => {
        this.connection = db;
        return db;
      })
      .catch((error: unknown) => {
        disconnected();
        throw error;
      }));
  }
}
