import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IonButton, IonItem, IonLabel, IonList, IonNote, IonSearchbar, IonSpinner, IonText } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useSelector } from 'react-redux';
import { type MessageResponse, searchMessages } from '@/api/messages';
import { UserAvatar } from '@/components/UserAvatar';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { formatMessagePreview, getNotificationPreviewLabels, truncatePreview } from '@/utils/messagePreview';
import { isMessageSearchQueryReady } from '@/utils/messageSearch';
import styles from './ChatMessageSearchPanel.module.scss';

const SEARCH_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 300;

interface ChatMessageSearchPanelProps {
  chatId: string;
  onOpenMessage: (message: MessageResponse) => void;
}

interface MessageSearchResultRowProps {
  message: MessageResponse;
  locale: string;
  onSelect: (message: MessageResponse) => void;
}

function formatResultTimestamp(isoString: string, locale: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameDay =
    date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();

  if (sameDay) {
    return Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  return Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  }).format(date);
}

function MessageSearchResultRow({ message, locale, onSelect }: MessageSearchResultRowProps) {
  const senderName = message.sender.name ?? `User ${message.sender.uid}`;
  const previewText = useMemo(() => {
    const formatted = formatMessagePreview(message, getNotificationPreviewLabels(locale));
    return truncatePreview(formatted || t`Message`);
  }, [locale, message]);
  const timestamp = useMemo(() => formatResultTimestamp(message.createdAt, locale), [locale, message.createdAt]);

  return (
    <IonItem button detail={false} className={styles.resultItem} onClick={() => onSelect(message)}>
      <div slot="start" className={styles.avatarSlot}>
        <UserAvatar name={senderName} avatarUrl={message.sender.avatarUrl} size={38} />
      </div>
      <IonLabel className={styles.resultLabel}>
        <div className={styles.resultHeader}>
          <span className={styles.senderName}>{senderName}</span>
          {timestamp ? <IonNote className={styles.timestamp}>{timestamp}</IonNote> : null}
        </div>
        <p className={styles.previewText}>{previewText}</p>
      </IonLabel>
    </IonItem>
  );
}

export function ChatMessageSearchPanel({ chatId, onOpenMessage }: ChatMessageSearchPanelProps) {
  const locale = useSelector(selectEffectiveLocale);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessageResponse[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const trimmedQuery = query.trim();
  const queryReady = isMessageSearchQueryReady(trimmedQuery);

  const handleQueryChange = useCallback((nextQuery: string) => {
    const nextReady = isMessageSearchQueryReady(nextQuery);
    abortControllerRef.current?.abort();
    requestSequenceRef.current += 1;
    setQuery(nextQuery);
    setError(null);
    setNextOffset(null);
    setLoadingMore(false);

    if (!nextReady) {
      setResults([]);
      setLoading(false);
      return;
    }

    setResults([]);
    setLoading(true);
  }, []);

  const runSearch = useCallback(
    (searchQuery: string, offset: number) => {
      const sequence = requestSequenceRef.current + 1;
      requestSequenceRef.current = sequence;
      abortControllerRef.current?.abort();

      const controller = new AbortController();
      abortControllerRef.current = controller;
      setError(null);
      if (offset === 0) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }

      searchMessages(chatId, { q: searchQuery, limit: SEARCH_LIMIT, offset }, { signal: controller.signal })
        .then((res) => {
          if (requestSequenceRef.current !== sequence || controller.signal.aborted) return;
          const messages = res.data.messages ?? [];
          setResults((current) => (offset === 0 ? messages : [...current, ...messages]));
          setNextOffset(res.data.nextOffset ?? null);
        })
        .catch((err: Error & { code?: string }) => {
          if (requestSequenceRef.current !== sequence || controller.signal.aborted || err.code === 'ERR_CANCELED') {
            return;
          }
          setError(t`Failed to search messages`);
          if (offset === 0) {
            setResults([]);
            setNextOffset(null);
          }
        })
        .finally(() => {
          if (requestSequenceRef.current !== sequence) return;
          if (abortControllerRef.current === controller) {
            abortControllerRef.current = null;
          }
          if (offset === 0) {
            setLoading(false);
          } else {
            setLoadingMore(false);
          }
        });
    },
    [chatId],
  );

  useEffect(() => {
    if (!queryReady) return;

    const timer = window.setTimeout(() => {
      runSearch(trimmedQuery, 0);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [queryReady, runSearch, trimmedQuery]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      requestSequenceRef.current += 1;
    };
  }, []);

  const handleLoadMore = useCallback(() => {
    if (!queryReady || nextOffset == null || loading || loadingMore) return;
    runSearch(trimmedQuery, nextOffset);
  }, [loading, loadingMore, nextOffset, queryReady, runSearch, trimmedQuery]);

  const stateMessage = useMemo(() => {
    if (queryReady || loading) return null;
    return trimmedQuery ? <Trans>Enter at least 2 characters</Trans> : <Trans>Search messages in this chat</Trans>;
  }, [loading, queryReady, trimmedQuery]);

  const showNoResults = queryReady && !loading && !error && results.length === 0;

  return (
    <div className={styles.layout}>
      <div className={styles.searchbarWrap}>
        <IonSearchbar
          className={styles.searchbar}
          value={query}
          debounce={0}
          onIonInput={(event) => handleQueryChange(event.detail.value ?? '')}
          enterkeyhint="search"
          placeholder={t`Search messages`}
          showClearButton="focus"
        />
      </div>

      {loading ? (
        <div className={styles.state}>
          <IonSpinner />
        </div>
      ) : null}

      {!loading && stateMessage ? <div className={styles.state}>{stateMessage}</div> : null}

      {!loading && error ? (
        <div className={styles.state}>
          <IonText color="danger">{error}</IonText>
        </div>
      ) : null}

      {showNoResults ? (
        <div className={styles.state}>
          <Trans>No messages found</Trans>
        </div>
      ) : null}

      {results.length > 0 ? (
        <IonList inset className={styles.resultList}>
          {results.map((message) => (
            <MessageSearchResultRow key={message.id} message={message} locale={locale} onSelect={onOpenMessage} />
          ))}
        </IonList>
      ) : null}

      {nextOffset != null ? (
        <div className={styles.loadMoreWrap}>
          <IonButton fill="clear" expand="block" disabled={loadingMore} onClick={handleLoadMore}>
            {loadingMore ? <IonSpinner name="crescent" /> : <Trans>Load More</Trans>}
          </IonButton>
        </div>
      ) : null}
    </div>
  );
}
