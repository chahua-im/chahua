import { useCallback, useEffect, useState } from 'react';
import { useIonAlert } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { useDispatch, useSelector } from 'react-redux';
import { archiveThread, getThreadSubscriptionStatus, subscribeToThread, unarchiveThread } from '@/api/threads';
import type { AppDispatch, RootState } from '@/store';
import {
  selectThreadArchivedStatus,
  selectThreadSubscriptionStatus,
  setThreadSubscriptionStatus,
} from '@/store/threadsSlice';
import { refreshThreadList } from '@/store/listPagination';

interface UseThreadSubscriptionArgs {
  chatId: string;
  threadId?: string;
}

export function useThreadSubscription({ chatId, threadId }: UseThreadSubscriptionArgs) {
  const dispatch = useDispatch<AppDispatch>();
  const [presentAlert] = useIonAlert();
  const [threadSubscribed, setThreadSubscribed] = useState<boolean | null>(null);
  const [threadArchived, setThreadArchived] = useState(false);
  const [threadSubLoading, setThreadSubLoading] = useState(false);
  const syncedThreadSubscribed = useSelector((state: RootState) =>
    threadId ? selectThreadSubscriptionStatus(state, threadId) : null,
  );
  const syncedThreadArchived = useSelector((state: RootState) =>
    threadId ? selectThreadArchivedStatus(state, threadId) : null,
  );

  useEffect(() => {
    if (!threadId || !chatId) return;
    setThreadSubscribed(null);
    getThreadSubscriptionStatus(chatId, threadId)
      .then((res) => {
        setThreadSubscribed(res.data.subscribed);
        setThreadArchived(res.data.archived);
        dispatch(
          setThreadSubscriptionStatus({
            threadRootId: threadId,
            subscribed: res.data.subscribed,
            archived: res.data.archived,
          }),
        );
      })
      .catch(() => setThreadSubscribed(null));
  }, [chatId, threadId, dispatch]);

  useEffect(() => {
    if (syncedThreadSubscribed != null) {
      setThreadSubscribed(syncedThreadSubscribed);
    }
  }, [syncedThreadSubscribed]);

  useEffect(() => {
    if (syncedThreadArchived != null) {
      setThreadArchived(syncedThreadArchived);
    }
  }, [syncedThreadArchived]);

  const markThreadSubscribedOptimistically = useCallback(() => {
    setThreadSubscribed(true);
  }, []);

  const handleToggleThreadSubscription = useCallback(async () => {
    if (!threadId || !chatId || threadSubscribed == null) return;

    if (threadArchived) {
      presentAlert({
        header: t`Unarchive thread?`,
        message: t`This thread will move back to Threads. Continue?`,
        buttons: [
          { text: t`Cancel`, role: 'cancel' },
          {
            text: t`Continue`,
            handler: () => {
              setThreadSubLoading(true);
              void unarchiveThread(chatId, threadId)
                .then(() => {
                  setThreadSubscribed(true);
                  setThreadArchived(false);
                  dispatch(setThreadSubscriptionStatus({ threadRootId: threadId, subscribed: true, archived: false }));
                })
                .catch((err) => console.error('Failed to unarchive thread', err))
                .finally(() => setThreadSubLoading(false));
            },
          },
        ],
      });
      return;
    }

    setThreadSubLoading(true);
    try {
      if (threadSubscribed) {
        await archiveThread(chatId, threadId);
        setThreadSubscribed(true);
        setThreadArchived(true);
        dispatch(setThreadSubscriptionStatus({ threadRootId: threadId, subscribed: true, archived: true }));
      } else {
        await subscribeToThread(chatId, threadId);
        setThreadSubscribed(true);
        setThreadArchived(false);
        dispatch(setThreadSubscriptionStatus({ threadRootId: threadId, subscribed: true, archived: false }));
        void dispatch(refreshThreadList(false)).catch(() => {});
      }
    } catch (err) {
      console.error('Failed to toggle thread archive state', err);
    } finally {
      setThreadSubLoading(false);
    }
  }, [chatId, threadArchived, threadId, threadSubscribed, dispatch, presentAlert]);

  return {
    threadSubscribed,
    threadArchived,
    threadSubLoading,
    handleToggleThreadSubscription,
    markThreadSubscribedOptimistically,
  };
}
