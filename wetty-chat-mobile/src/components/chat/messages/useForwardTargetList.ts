import { useEffect, useState } from 'react';
import { getChats, type ChatListEntry } from '@/api/chats';
import { getThreads, type ThreadListItem } from '@/api/threads';
import { t } from '@lingui/core/macro';

const FORWARD_THREAD_LIMIT = 50;

export function useForwardTargetList(isOpen: boolean) {
  const [chats, setChats] = useState<ChatListEntry[]>([]);
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    Promise.all([getChats({ archived: false }), getThreads({ limit: FORWARD_THREAD_LIMIT, archived: false })])
      .then(([chatRes, threadRes]) => {
        if (!cancelled) {
          setChats(chatRes.data.chats);
          setThreads(threadRes.data.threads);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t`Failed to load chats`);
          setLoading(false);
        }
      });

    // Delayed loading indicator to avoid synchronous setState in effect body.
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // When closed, return empty state without triggering re-renders.
  // Stale data from previous opens is overwritten by the next fetch callback.
  return isOpen ? { chats, threads, loading, error } : { chats: [], threads: [], loading: false, error: null };
}
