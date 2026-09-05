import { getChats, type ChatListEntry } from '@/api/chats';
import { getThreads, type ThreadListItem } from '@/api/threads';
import type { AppDispatch, RootState } from '@/store';
import { appendChatsList, setChatsList, setChatsListLoading } from './chatsSlice';
import { appendThreads, setThreadsList, setThreadsListLoading } from './threadsSlice';

type ListBucket = 'chat-active' | 'chat-archived' | 'thread-active' | 'thread-archived';
type ListThunk = (dispatch: AppDispatch, getState: () => RootState) => Promise<void>;

interface ListRegistry {
  queuedWork: Partial<Record<ListBucket, Promise<void>>>;
  refreshWork: Partial<Record<ListBucket, Promise<void>>>;
  loadMoreWork: Partial<Record<ListBucket, Promise<void>>>;
  pendingWorkCount: Partial<Record<ListBucket, number>>;
}

const registriesByDispatch = new WeakMap<AppDispatch, ListRegistry>();

function registryFor(dispatch: AppDispatch): ListRegistry {
  const existing = registriesByDispatch.get(dispatch);
  if (existing) return existing;

  const registry: ListRegistry = {
    queuedWork: {},
    refreshWork: {},
    loadMoreWork: {},
    pendingWorkCount: {},
  };
  registriesByDispatch.set(dispatch, registry);
  return registry;
}

function bucketFor(kind: 'chat' | 'thread', archived: boolean): ListBucket {
  return `${kind}-${archived ? 'archived' : 'active'}`;
}

function enqueue(registry: ListRegistry, bucket: ListBucket, operation: () => Promise<void>): Promise<void> {
  const previous = registry.queuedWork[bucket] ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(operation);
  registry.queuedWork[bucket] = task;
  const clear = () => {
    if (registry.queuedWork[bucket] === task) delete registry.queuedWork[bucket];
  };
  void task.then(clear, clear);
  return task;
}

function trackLoading(
  registry: ListRegistry,
  bucket: ListBucket,
  dispatch: AppDispatch,
  archived: boolean,
  kind: 'chat' | 'thread',
  task: Promise<void>,
): Promise<void> {
  registry.pendingWorkCount[bucket] = (registry.pendingWorkCount[bucket] ?? 0) + 1;
  if (kind === 'chat') dispatch(setChatsListLoading({ archived, isLoading: true }));
  else dispatch(setThreadsListLoading({ archived, isLoading: true }));

  const finish = () => {
    const remaining = (registry.pendingWorkCount[bucket] ?? 1) - 1;
    if (remaining === 0) {
      delete registry.pendingWorkCount[bucket];
      if (kind === 'chat') dispatch(setChatsListLoading({ archived, isLoading: false }));
      else dispatch(setThreadsListLoading({ archived, isLoading: false }));
    } else {
      registry.pendingWorkCount[bucket] = remaining;
    }
  };
  return task.then(
    () => finish(),
    (error: unknown) => {
      finish();
      throw error;
    },
  );
}

function schedule(
  bucket: ListBucket,
  kind: 'chat' | 'thread',
  archived: boolean,
  dispatch: AppDispatch,
  operationKind: 'refresh' | 'load-more',
  operation: () => Promise<void>,
): Promise<void> {
  const storeRegistry = registryFor(dispatch);
  const registry = operationKind === 'refresh' ? storeRegistry.refreshWork : storeRegistry.loadMoreWork;
  const existing = registry[bucket];
  if (existing) return existing;

  const result = trackLoading(
    storeRegistry,
    bucket,
    dispatch,
    archived,
    kind,
    enqueue(storeRegistry, bucket, operation),
  );
  registry[bucket] = result;
  const clear = () => {
    if (registry[bucket] === result) delete registry[bucket];
  };
  void result.then(clear, clear);
  return result;
}

export function refreshChatList(archived: boolean): ListThunk {
  return (dispatch, getState) => {
    const bucket = bucketFor('chat', archived);
    return schedule(bucket, 'chat', archived, dispatch, 'refresh', async () => {
      const pageDepth = Math.max(1, getState().chats.buckets[archived ? 'archived' : 'active'].pageDepth);
      const chats: ChatListEntry[] = [];
      let nextCursor: string | null = null;
      let loadedPages = 0;

      for (let page = 0; page < pageDepth; page += 1) {
        const response = await getChats({ limit: 100, after: nextCursor ?? undefined, archived });
        chats.push(...(response.data.chats ?? []));
        nextCursor = response.data.nextCursor;
        loadedPages += 1;
        if (!nextCursor) break;
      }

      dispatch(setChatsList({ chats, nextCursor, archived, pageDepth: loadedPages }));
    });
  };
}

export function loadMoreChatList(archived: boolean): ListThunk {
  return (dispatch, getState) => {
    const bucket = bucketFor('chat', archived);
    return schedule(bucket, 'chat', archived, dispatch, 'load-more', async () => {
      const nextCursor = getState().chats.buckets[archived ? 'archived' : 'active'].nextCursor;
      if (!nextCursor) return;
      const response = await getChats({ limit: 100, after: nextCursor, archived });
      dispatch(appendChatsList({ chats: response.data.chats ?? [], nextCursor: response.data.nextCursor, archived }));
    });
  };
}

export function refreshThreadList(archived: boolean): ListThunk {
  return (dispatch, getState) => {
    const bucket = bucketFor('thread', archived);
    return schedule(bucket, 'thread', archived, dispatch, 'refresh', async () => {
      const pageDepth = Math.max(1, getState().threads.buckets[archived ? 'archived' : 'active'].pageDepth);
      const threads: ThreadListItem[] = [];
      let nextCursor: string | null = null;
      let loadedPages = 0;

      for (let page = 0; page < pageDepth; page += 1) {
        const response = await getThreads({ limit: 20, before: nextCursor ?? undefined, archived });
        threads.push(...response.data.threads);
        nextCursor = response.data.nextCursor;
        loadedPages += 1;
        if (!nextCursor) break;
      }

      dispatch(setThreadsList({ threads, nextCursor, archived, pageDepth: loadedPages }));
    });
  };
}

export function loadMoreThreadList(archived: boolean): ListThunk {
  return (dispatch, getState) => {
    const bucket = bucketFor('thread', archived);
    return schedule(bucket, 'thread', archived, dispatch, 'load-more', async () => {
      const nextCursor = getState().threads.buckets[archived ? 'archived' : 'active'].nextCursor;
      if (!nextCursor) return;
      const response = await getThreads({ limit: 20, before: nextCursor, archived });
      dispatch(appendThreads({ threads: response.data.threads, nextCursor: response.data.nextCursor, archived }));
    });
  };
}
