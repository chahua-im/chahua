import apiClient from '@/api/client';
import { syncApp } from '@/api/sync';
import type { MessageResponse, ReactionSummary } from '@/api/messages';
import { setActiveConnections, setWsConnected } from '@/store/connectionSlice';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { setChatArchived, setChatMutedUntil } from '@/store/chatsSlice';
import {
  removeThread,
  setThreadSubscriptionStatus,
  setThreadsList,
  updateThreadFromWs,
  type ThreadUpdatePayload,
} from '@/store/threadsSlice';
import { addPin, removePin } from '@/store/pinsSlice';
import { replaceStickerPackOrderFromWs } from '@/store/stickerPreferencesSlice';
import type { PinResponse } from '@/api/pins';
import { getThreadSubscriptionStatus, getThreads } from '@/api/threads';
import store from '@/store/index';
import {
  messageAdded,
  messageConfirmed,
  messagePatched,
  messagesBulkDeleted,
  reactionsUpdated,
} from '@/store/messageEvents';
import { selectAllTimelineMessages } from '@/store/messages/selectors';
import { getStoredJwtToken } from '@/utils/jwtToken';
import { formatNotificationBody, getNotificationPreviewLabels } from '@/utils/messagePreview';
import { buildNotificationNavigationData } from '@/utils/notificationNavigation';

const WS_PATH = __API_BASE__ + '/ws';
const PING_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_JITTER_RATIO = 0.2;

export type WebSocketAppState = 'active' | 'inactive';

interface ServerEnvelope {
  type?: string;
  payload?: unknown;
}

interface AuthMessage {
  type: 'auth';
  ticket: string;
}

interface PingMessage {
  type: 'ping';
  state: WebSocketAppState;
}

interface AppStateMessage {
  type: 'appState';
  state: WebSocketAppState;
}

interface ThreadMembershipChangedPayload {
  chatId: string;
  threadRootId: string;
}

const STABLE_CONNECTION_MS = 5_000;

let ws: WebSocket | null = null;
let pingIntervalId: ReturnType<typeof setInterval> | null = null;
let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
let stableResetTimeoutId: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let isInitialized = false;
let isConnecting = false;
let connectGeneration = 0;
let currentAppState: WebSocketAppState = 'active';
let networkOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
const intentionalClosures = new WeakSet<WebSocket>();

export async function requestWsTicket(): Promise<string> {
  const res = await apiClient.get<{ ticket: string }>('/ws/ticket');
  return res.data.ticket;
}

function resolveWebSocketUrl(path: string): string {
  if (typeof location === 'undefined') {
    return path;
  }

  // Full URL — map http(s) → ws(s) directly
  if (path.startsWith('http://') || path.startsWith('https://')) {
    const url = new URL(path);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  // Relative path — derive protocol from the current page
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path}`;
}

function clearPingInterval(): void {
  if (pingIntervalId != null) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }
}

function clearReconnectTimeout(): void {
  if (reconnectTimeoutId != null) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
}

function clearStableResetTimeout(): void {
  if (stableResetTimeoutId != null) {
    clearTimeout(stableResetTimeoutId);
    stableResetTimeoutId = null;
  }
}

function getReconnectDelayMs(): number {
  const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** retryAttempt, MAX_RECONNECT_DELAY_MS);
  const jitter = Math.round(exponential * RETRY_JITTER_RATIO * Math.random());
  return Math.min(exponential + jitter, MAX_RECONNECT_DELAY_MS);
}

function normalizePayload(payload: unknown): MessageResponse | null {
  if (payload == null || typeof payload !== 'object') return null;
  const msg = payload as MessageResponse;
  if (!msg.chatId || !msg.id) return null;
  return msg;
}

function allMessagesForChat(chatId: string): MessageResponse[] {
  return selectAllTimelineMessages(store.getState(), chatId);
}

function showLocalNotification(message: MessageResponse): void {
  if (currentAppState !== 'inactive') return;

  // Skip notification if user is active on another connection
  const { activeConnections } = store.getState().connection;
  if (activeConnections > 1) return;

  const currentUid = store.getState().user.uid;
  if (currentUid != null && message.sender.uid === currentUid) return;
  if (message.isDeleted) return;
  if (message.messageType === 'system') return;

  // Skip local notification for thread replies if user is not subscribed
  if (message.replyRootId) {
    const threadItems = store.getState().threads.items;
    const threadEntry = threadItems.find((t) => t.threadRootMessage.id === message.replyRootId);
    if (!threadEntry || threadEntry.archived) return;
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const chatEntry = store.getState().chats.byId[message.chatId];

  // Skip notification for muted chats
  const mutedUntil =
    chatEntry?.liveProjection && Object.prototype.hasOwnProperty.call(chatEntry.liveProjection, 'mutedUntil')
      ? (chatEntry.liveProjection.mutedUntil ?? null)
      : (chatEntry?.listSnapshot?.mutedUntil ?? null);
  if (mutedUntil && new Date(mutedUntil) > new Date()) return;

  const chatName = chatEntry?.details?.name ?? 'New Message';
  const locale = selectEffectiveLocale(store.getState());
  const body = formatNotificationBody(message.sender.name ?? 'Someone', message, getNotificationPreviewLabels(locale));

  const tag = `msg_${message.id}`;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        registration.showNotification(chatName, {
          body,
          icon: '/icon/pwa-192x192.png',
          badge: '/icon/pwa-64x64.png',
          tag,
          data: buildNotificationNavigationData({
            chatId: message.chatId,
            messageId: message.id,
            threadRootId: message.replyRootId ?? undefined,
          }),
        });

        // Inform the SW of the notified message so it can skip stale push notifications
        registration.active?.postMessage({
          type: 'NOTIFIED',
          chatId: message.chatId,
          messageId: message.id,
        });
      })
      .catch(() => {
        /* SW not available */
      });
  }
}

function handleWsMessage(payload: unknown): void {
  const message = normalizePayload(payload);
  if (!message) return;

  const storeChatId = message.replyRootId ? `${message.chatId}_thread_${message.replyRootId}` : message.chatId;
  const all = allMessagesForChat(storeChatId);
  const pending = all.find(
    (current) => current.clientGeneratedId === message.clientGeneratedId && current.id.startsWith('cg_'),
  );

  if (pending) {
    console.debug('[msg-trace] ws:confirm', {
      msgId: message.id,
      cgId: message.clientGeneratedId,
      pendingId: pending.id,
      chatId: message.chatId,
    });
    store.dispatch(
      messageConfirmed({
        chatId: message.chatId,
        storeChatId,
        clientGeneratedId: message.clientGeneratedId,
        message,
        origin: 'ws',
        scope: message.replyRootId ? 'thread' : 'main',
      }),
    );
  } else {
    const exists = all.some(
      (current) => current.id === message.id || current.clientGeneratedId === message.clientGeneratedId,
    );
    if (!exists) {
      console.debug('[msg-trace] ws:add', {
        msgId: message.id,
        cgId: message.clientGeneratedId ?? null,
        chatId: message.chatId,
        storeChatId,
      });
      store.dispatch(
        messageAdded({
          chatId: message.chatId,
          storeChatId,
          message,
          origin: 'ws',
          scope: message.replyRootId ? 'thread' : 'main',
        }),
      );
      showLocalNotification(message);
    } else {
      console.debug('[msg-trace] ws:skip-exists', {
        msgId: message.id,
        cgId: message.clientGeneratedId ?? null,
        chatId: message.chatId,
      });
    }
  }
}

function refreshThreadsList(): void {
  getThreads()
    .then((res) => {
      store.dispatch(setThreadsList({ threads: res.data.threads, nextCursor: res.data.nextCursor, archived: false }));
    })
    .catch((err) => console.error('Failed to refresh threads list from websocket event', err));
}

function sendJson(message: AuthMessage | PingMessage | AppStateMessage): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function publishAppState(): void {
  sendJson({ type: 'appState', state: currentAppState });
}

function closeSocket(socket: WebSocket | null): void {
  if (socket == null) return;
  intentionalClosures.add(socket);
  try {
    socket.close();
  } catch {
    // ignore
  }
}

function markDisconnected(socket: WebSocket, shouldReconnect: boolean): void {
  if (intentionalClosures.has(socket)) {
    intentionalClosures.delete(socket);
  }

  if (ws === socket) {
    ws = null;
  }

  clearPingInterval();
  clearStableResetTimeout();
  isConnecting = false;
  store.dispatch(setWsConnected(false));

  if (shouldReconnect) {
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!isInitialized) return;
  if (ws != null || isConnecting) return;
  if (!networkOnline) {
    clearReconnectTimeout();
    return;
  }
  if (reconnectTimeoutId != null) return;

  const delay = getReconnectDelayMs();
  retryAttempt += 1;
  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    void connectWebSocket();
  }, delay);
}

async function connectWebSocket(): Promise<void> {
  if (!isInitialized) return;
  if (typeof WebSocket === 'undefined') return;
  if (!networkOnline) {
    store.dispatch(setWsConnected(false));
    return;
  }
  if (ws != null || isConnecting) return;

  isConnecting = true;
  clearReconnectTimeout();
  const generation = ++connectGeneration;

  try {
    const ticket = getStoredJwtToken() || (await requestWsTicket());
    if (generation !== connectGeneration || !isInitialized || !networkOnline) {
      isConnecting = false;
      return;
    }

    const socket = new WebSocket(resolveWebSocketUrl(WS_PATH));
    ws = socket;

    socket.onopen = () => {
      if (generation !== connectGeneration) {
        closeSocket(socket);
        return;
      }

      isConnecting = false;
      clearStableResetTimeout();
      stableResetTimeoutId = setTimeout(() => {
        stableResetTimeoutId = null;
        retryAttempt = 0;
      }, STABLE_CONNECTION_MS);
      store.dispatch(setWsConnected(true));

      sendJson({ type: 'auth', ticket });
      publishAppState();
      syncApp();

      clearPingInterval();
      pingIntervalId = setInterval(() => {
        sendJson({ type: 'ping', state: currentAppState });
      }, PING_INTERVAL_MS);
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;

      try {
        const message = JSON.parse(event.data) as ServerEnvelope;
        if (message.type === 'pong') {
          return;
        }

        if (message.type === 'message' && message.payload != null) {
          handleWsMessage(message.payload);
          return;
        }

        if ((message.type === 'messageDeleted' || message.type === 'messageUpdated') && message.payload != null) {
          const payload = normalizePayload(message.payload);
          if (!payload) return;
          store.dispatch(
            messagePatched({
              chatId: payload.chatId,
              messageId: payload.id,
              message: payload,
            }),
          );
          return;
        }

        if (message.type === 'messagesBulkDeleted' && message.payload != null) {
          const payload = message.payload as { chatId: string; messageIds: string[] };
          if (payload.chatId && payload.messageIds?.length) {
            store.dispatch(
              messagesBulkDeleted({
                chatId: payload.chatId,
                messageIds: payload.messageIds,
              }),
            );
          }
          return;
        }

        if (message.type === 'reactionUpdated' && message.payload != null) {
          const payload = message.payload as {
            messageId: string;
            chatId: string;
            reactions: ReactionSummary[];
          };
          if (payload.messageId && payload.chatId) {
            store.dispatch(
              reactionsUpdated({
                chatId: payload.chatId,
                messageId: payload.messageId,
                reactions: payload.reactions ?? [],
              }),
            );
          }
          return;
        }

        if (message.type === 'presenceUpdate' && message.payload != null) {
          const payload = message.payload as { activeConnections: number };
          store.dispatch(setActiveConnections(payload.activeConnections));
          return;
        }

        if (message.type === 'pinAdded' && message.payload != null) {
          const payload = message.payload as { pin?: PinResponse };
          if (payload.pin) {
            store.dispatch(addPin(payload.pin));
          }
          return;
        }

        if (message.type === 'pinRemoved' && message.payload != null) {
          const payload = message.payload as { chatId: string; pinId: string };
          if (payload.chatId && payload.pinId) {
            store.dispatch(removePin({ chatId: payload.chatId, pinId: payload.pinId }));
          }
          return;
        }

        if (message.type === 'threadUpdate' && message.payload != null) {
          const payload = message.payload as ThreadUpdatePayload;
          if (payload.threadRootId && payload.chatId) {
            const threadsState = store.getState().threads;
            const alreadyKnown = threadsState.items.some((t) => t.threadRootMessage.id === payload.threadRootId);
            store.dispatch(setThreadSubscriptionStatus({ threadRootId: payload.threadRootId, subscribed: true }));
            store.dispatch(updateThreadFromWs(payload));
            if (!alreadyKnown && threadsState.buckets.active.isLoaded) {
              refreshThreadsList();
            }
          }
          return;
        }

        if (message.type === 'threadMembershipChanged' && message.payload != null) {
          const payload = message.payload as ThreadMembershipChangedPayload;
          if (payload.threadRootId && payload.chatId) {
            getThreadSubscriptionStatus(payload.chatId, payload.threadRootId)
              .then((res) => {
                store.dispatch(
                  setThreadSubscriptionStatus({
                    threadRootId: payload.threadRootId,
                    subscribed: res.data.subscribed,
                    archived: res.data.archived,
                  }),
                );

                if (!res.data.subscribed) {
                  store.dispatch(removeThread({ threadRootId: payload.threadRootId }));
                  return;
                }

                if (store.getState().threads.buckets.active.isLoaded) {
                  refreshThreadsList();
                }
              })
              .catch((err) => console.error('Failed to refresh thread membership after websocket event', err));
          }
          return;
        }

        if (message.type === 'chatArchiveStateChanged' && message.payload != null) {
          const payload = message.payload as { chatId: string; archived: boolean; mutedUntil?: string | null };
          if (payload.chatId) {
            store.dispatch(setChatArchived({ chatId: payload.chatId, archived: payload.archived }));
            store.dispatch(setChatMutedUntil({ chatId: payload.chatId, mutedUntil: payload.mutedUntil ?? null }));
          }
          return;
        }

        if (message.type === 'stickerPackOrderUpdated' && message.payload != null) {
          const payload = message.payload as { order: { stickerPackId: string; lastUsedOn: number }[] };
          if (payload.order) {
            store.dispatch(replaceStickerPackOrderFromWs(payload.order));
          }
        }
      } catch {
        // ignore malformed websocket messages
      }
    };

    socket.onerror = () => {
      markDisconnected(socket, !intentionalClosures.has(socket));
    };

    socket.onclose = () => {
      markDisconnected(socket, !intentionalClosures.has(socket));
    };
  } catch (error) {
    isConnecting = false;
    store.dispatch(setWsConnected(false));
    console.error('Failed to establish websocket:', error);
    scheduleReconnect();
  }
}

function reconnectNow(resetBackoff: boolean): void {
  if (!isInitialized) return;
  if (!networkOnline) {
    store.dispatch(setWsConnected(false));
    clearReconnectTimeout();
    return;
  }

  clearReconnectTimeout();
  clearStableResetTimeout();
  if (resetBackoff) {
    retryAttempt = 0;
  }
  connectGeneration += 1;

  const currentSocket = ws;
  ws = null;
  closeSocket(currentSocket);
  clearPingInterval();
  isConnecting = false;

  void connectWebSocket();
}

export function initWebSocket(): void {
  if (isInitialized) return;
  isInitialized = true;
  void connectWebSocket();
}

export function setWebSocketAppState(state: WebSocketAppState): void {
  currentAppState = state;
  publishAppState();
}

export function handleWebSocketOnline(): void {
  networkOnline = true;
  reconnectNow(true);
}

export function handleWebSocketOffline(): void {
  networkOnline = false;
  clearReconnectTimeout();
  clearPingInterval();
  closeSocket(ws);
  ws = null;
  isConnecting = false;
  store.dispatch(setWsConnected(false));
}

export function ensureWebSocketConnected(resetBackoff = false): void {
  if (ws != null || isConnecting) return;
  reconnectNow(resetBackoff);
}
