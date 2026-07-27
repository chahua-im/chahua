import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonList,
  IonModal,
  IonNote,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MemberSummary } from '@/api/users';
import { usersApi } from '@/api/users';
import { ChatMemberRow } from '@/components/chat-members/ChatMemberRow';
import { useHasGlobalPermission } from '@/hooks/useHasGlobalPermission';

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 20;

interface AddFriendModalProps {
  isOpen: boolean;
  onDismiss: () => void;
  onSelect: (member: MemberSummary) => void;
}

export function AddFriendModal({ isOpen, onDismiss, onSelect }: AddFriendModalProps) {
  const canViewAllMembers = useHasGlobalPermission('member.viewAll');
  const [searchText, setSearchText] = useState('');
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  const runSearch = useCallback((value: string) => {
    const trimmed = value.trim();
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    if (!trimmed) {
      setMembers([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    usersApi
      .searchMembers({ q: trimmed, limit: SEARCH_LIMIT })
      .then((response) => {
        if (requestIdRef.current !== requestId) return;
        setMembers(response.members);
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setMembers([]);
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = window.setTimeout(() => {
      void runSearch(searchText);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [runSearch, searchText, isOpen]);

  // Reset state when the sheet closes so it reopens fresh.
  useEffect(() => {
    if (!isOpen) {
      setSearchText('');
      setMembers([]);
      setLoading(false);
    }
  }, [isOpen]);

  const searchPlaceholder = canViewAllMembers ? t`Search by username or UID` : t`Enter a user UID`;
  const hasQuery = searchText.trim().length > 0;

  const handleSelect = useCallback(
    (member: MemberSummary) => {
      onSelect(member);
    },
    [onSelect],
  );

  return (
    <IonModal isOpen={isOpen} onDidDismiss={onDismiss}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>
            <Trans>Add Friend</Trans>
          </IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={onDismiss}>
              <Trans>Cancel</Trans>
            </IonButton>
          </IonButtons>
        </IonToolbar>
        <IonToolbar>
          <IonSearchbar
            value={searchText}
            onIonInput={(event) => setSearchText(event.detail.value ?? '')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void runSearch(searchText);
              }
            }}
            enterkeyhint="search"
            placeholder={searchPlaceholder}
            showClearButton="focus"
          />
        </IonToolbar>
      </IonHeader>
      <IonContent color="light">
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <IonSpinner />
          </div>
        ) : null}

        {!loading && !hasQuery ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <IonNote color="medium">
              {canViewAllMembers ? (
                <Trans>Search for a user by username prefix or exact UID.</Trans>
              ) : (
                <Trans>Enter an exact UID to find a specific user.</Trans>
              )}
            </IonNote>
          </div>
        ) : null}

        {!loading && hasQuery && members.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <IonNote color="medium">
              <Trans>No matching users found.</Trans>
            </IonNote>
          </div>
        ) : null}

        {!loading && members.length > 0 ? (
          <IonList inset>
            {members.map((member) => (
              <ChatMemberRow
                key={`search-${member.uid}`}
                member={member}
                subtitle={t`UID ${member.uid}`}
                onSelect={handleSelect}
              />
            ))}
          </IonList>
        ) : null}
      </IonContent>
    </IonModal>
  );
}
