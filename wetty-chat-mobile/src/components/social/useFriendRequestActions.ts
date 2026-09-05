import { useIonAlert, useIonToast } from '@ionic/react';
import { t } from '@lingui/core/macro';
import axios from 'axios';
import { useDispatch } from 'react-redux';
import { friendsApi } from '@/api/friends';
import type { AppDispatch } from '@/store';
import { fetchArchivedRequests, fetchFriends, fetchPendingRequests } from '@/store/socialSlice';

export function useFriendRequestActions(): {
  acceptRequest: (requestId: string) => Promise<void>;
  rejectRequest: (requestId: string, fromUid: number) => Promise<void>;
  archiveRequest: (requestId: string) => Promise<void>;
} {
  const dispatch = useDispatch<AppDispatch>();
  const [presentToast] = useIonToast();
  const [presentAlert] = useIonAlert();

  async function acceptRequest(requestId: string): Promise<void> {
    try {
      await friendsApi.acceptRequest(requestId);
      dispatch(fetchFriends());
      dispatch(fetchPendingRequests());
      dispatch(fetchArchivedRequests());
    } catch (err) {
      presentToast(err instanceof Error ? err.message : t`Failed to accept request`, 2000);
    }
  }

  async function rejectRequest(requestId: string, fromUid: number): Promise<void> {
    await presentAlert({
      header: t`Reject Friend Request`,
      message: t`Reject this friend request?`,
      buttons: [
        { text: t`Cancel`, role: 'cancel' },
        {
          text: t`Reject`,
          role: 'destructive',
          handler: async () => {
            try {
              await friendsApi.rejectRequest(requestId);
              dispatch(fetchPendingRequests());
              dispatch(fetchArchivedRequests());
            } catch (err) {
              // A 409 means the server already dismissed the request; refresh the lists
              // so the history is current, then explain which conflict happened.
              const [friends] = await Promise.all([
                dispatch(fetchFriends()).unwrap(),
                dispatch(fetchPendingRequests()).unwrap(),
                dispatch(fetchArchivedRequests()).unwrap(),
              ]);
              const status = axios.isAxiosError(err) ? err.response?.status : undefined;
              if (status === 409) {
                presentToast(
                  friends.some((f) => f.user.uid === fromUid)
                    ? t`You are already friends with this user`
                    : t`This friend request is no longer pending`,
                  2000,
                );
                return;
              }
              presentToast(t`Failed to reject request`, 2000);
            }
          },
        },
      ],
    });
  }

  async function archiveRequest(requestId: string): Promise<void> {
    try {
      await friendsApi.archiveRequest(requestId);
      dispatch(fetchPendingRequests());
    } catch (err) {
      presentToast(err instanceof Error ? err.message : t`Failed to archive request`, 2000);
    }
  }

  return { acceptRequest, rejectRequest, archiveRequest };
}
