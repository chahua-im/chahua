import { HttpErrorResponse } from '@angular/common/http';
import { inject, isDevMode, Service, signal } from '@angular/core';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { AuthService } from '../../generated/endpoints/auth/auth.service';
import { UsersService } from '../../generated/endpoints/users/users.service';
import type { ChatSettings, MeResponse, StickerPackOrderItem, User } from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';

declare const CHAHUA_DEV_TOKEN: string | undefined;
declare const CHAHUA_DEV_BACKEND: boolean | undefined;

const TOKEN_KEY = 'jwt_token';
// Angular releases before the storage-name alignment used this key in both stores.
const LEGACY_TOKEN_KEY = 'chahua.auth.token';

const DEV_UID_KEY = 'uid';
const DEFAULT_DEV_UID = 1;
const CLIENT_ID_KEY = 'chahua.client-id';

export class ChatSettingsChanged extends Error {}

@Service()
export class SessionStore {
  private urlTokenAdopted = false;
  private chatSettingsWrite = 0;
  private readonly auth = inject(AuthService);
  private readonly users = inject(UsersService);
  readonly token = signal<string | undefined>(undefined);
  readonly user = signal<(MeResponse & Pick<User, 'userGroup'>) | undefined>(undefined);
  restoreToken() {
    const url = new URL(window.location.href);
    const urlToken = url.searchParams.get('token');
    const stored = storedToken(TOKEN_KEY) ?? storedToken(LEGACY_TOKEN_KEY) ?? developmentToken();
    const token = urlToken && sameSession(urlToken, stored) ? stored : (urlToken ?? stored);
    url.searchParams.delete('token');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);

    if (urlToken) this.urlTokenAdopted = true;
    if (token) this.saveToken(token);
  }

  async initialize() {
    // One deadline for the whole login attempt; timeout unsubscribes the active
    // HTTP request so a late response cannot overwrite a subsequent retry.
    const deadline = new Date(Date.now() + 30000);
    const request = <T>(response: Observable<T>) => firstValueFrom(response.pipe(timeout({ first: deadline })));
    try {
      // The per-tab dev UID needs a fresh local session on each page load.
      // An explicit URL credential suppresses this even when its matching stored
      // token is retained. A configured development token also suppresses it.
      if (isDevMode() && devBackendEnabled() && !this.urlTokenAdopted && !developmentToken()) {
        try {
          const { token } = await request(
            this.auth.postDevSession({ uid: developmentUid() }, { headers: { 'X-Client-Id': developmentClientId() } }),
          );
          this.saveToken(token);
        } catch (error) {
          // If the dev-session endpoint is down, continue with a previously
          // issued token when one exists.
          if (!this.token()) throw error;
        }
      }
      if (!this.token()) return;
      const refreshed = await request(this.auth.postRefresh());
      this.saveToken(refreshed.token);
      const user = await request(this.users.getMe());
      // /users/me omits the group tag; the existing UID lookup includes it.
      const profile = await request(this.users.getUserSearch({ q: String(user.uid), limit: 1 })).catch(() => undefined);
      this.user.set({ ...user, userGroup: profile?.members.find((member) => member.uid === user.uid)?.userGroup });
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) this.logout();
      throw error;
    }
  }

  async setShowMembershipMessages(showMembershipMessages: boolean) {
    const uid = this.user()?.uid;
    if (uid == null) return;
    const write = ++this.chatSettingsWrite;
    const settings = await firstValueFrom(this.users.putChatSettings({ showMembershipMessages }));
    if (write !== this.chatSettingsWrite || this.user()?.uid !== uid) return;
    this.acceptChatSettings(settings, uid);
  }

  /** Adopt the server value on normal reads; other devices converge on their next refresh. */
  acceptChatSettings(settings: ChatSettings, uid: number | undefined) {
    const user = this.user();
    if (!user || user.uid !== uid || settings.showMembershipMessages === user.showMembershipMessages) return;
    this.user.set({
      ...user,
      showMembershipMessages: settings.showMembershipMessages,
    });
  }

  requireChatSettings(settings: ChatSettings, requestedUser: MeResponse | undefined, filtersMembershipMessages = true) {
    if (requestedUser && requestedUser.uid !== this.user()?.uid) throw new Error('Account changed');
    // A local change since this request started takes precedence over its stale response.
    if (requestedUser && requestedUser.showMembershipMessages !== this.user()?.showMembershipMessages) {
      if (filtersMembershipMessages) throw new ChatSettingsChanged();
      return;
    }
    this.acceptChatSettings(settings, requestedUser?.uid);
    const show = this.user()?.showMembershipMessages ?? true;
    if (
      filtersMembershipMessages &&
      (settings.showMembershipMessages !== show || show !== (requestedUser?.showMembershipMessages ?? true))
    )
      throw new ChatSettingsChanged();
  }

  updateProfile(data: unknown) {
    const current = this.user();
    if (!current) return;
    const profile = findOwnProfile(data, current.uid);
    if (!profile) return;
    this.user.set({
      ...current,
      username: profile.username ?? profile.name ?? current.username,
      gender: profile.gender ?? current.gender,
      avatarUrl: 'avatarUrl' in profile ? profile.avatarUrl : current.avatarUrl,
      // Full public profiles omit an absent group; /users/me and reaction avatars do not carry group data.
      userGroup:
        'userGroup' in profile || ('gender' in profile && !('permissions' in profile))
          ? profile.userGroup
          : current.userGroup,
    });
  }

  replaceStickerPackOrder(order: StickerPackOrderItem[]) {
    const seen = new Set<SnowflakeID>();
    const merged = order
      .filter((item) => !seen.has(item.stickerPackId) && seen.add(item.stickerPackId))
      .map((item) => ({ ...item, lastUsedOn: Math.trunc(item.lastUsedOn) }));
    this.updateOrder(() => merged);
  }

  upsertStickerPackOrderItem(item: StickerPackOrderItem) {
    const normalized = { ...item, lastUsedOn: Math.trunc(item.lastUsedOn) };
    this.updateOrder((current) => [
      normalized,
      ...current.filter((existing) => existing.stickerPackId !== item.stickerPackId),
    ]);
  }

  removeStickerPackOrderItem(packId: SnowflakeID) {
    this.updateOrder((current) => current.filter((item) => item.stickerPackId !== packId));
  }

  private updateOrder(update: (current: StickerPackOrderItem[]) => StickerPackOrderItem[]) {
    const current = this.user();
    if (!current) return;
    this.user.set({ ...current, stickerPackOrder: update(current.stickerPackOrder) });
  }

  logout() {
    this.chatSettingsWrite++;
    this.saveToken(undefined);
    this.user.set(undefined);
  }

  devUid() {
    return developmentUid();
  }

  switchDevUid(uid: number) {
    sessionStorage.setItem(DEV_UID_KEY, String(uid));
    this.logout();
  }

  private saveToken(token: string | undefined) {
    this.token.set(token);
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
    // Safari copies cookies into a newly installed PWA, but not localStorage.
    // Cookies ignore ports, so development cookies need an origin-specific name.
    document.cookie = `${cookieKey(TOKEN_KEY)}=${token ?? ''}; Path=/; Max-Age=${token ? 400 * 24 * 60 * 60 : 0}; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`;
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
    document.cookie = `${cookieKey(LEGACY_TOKEN_KEY)}=; Path=/; Max-Age=0`;
  }
}

function developmentUid() {
  const uid = Number(sessionStorage.getItem(DEV_UID_KEY));
  return Number.isInteger(uid) && uid > 0 ? uid : DEFAULT_DEV_UID;
}

function developmentToken() {
  return isDevMode() && typeof CHAHUA_DEV_TOKEN !== 'undefined' ? CHAHUA_DEV_TOKEN : undefined;
}

/** Dev-session tooling only runs against a local backend; tests have no define and stay enabled. */
export function devBackendEnabled() {
  return typeof CHAHUA_DEV_BACKEND === 'undefined' ? true : CHAHUA_DEV_BACKEND;
}

function developmentClientId() {
  const stored = localStorage.getItem(CLIENT_ID_KEY);
  if (stored) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const clientId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}

function cookieKey(key: string) {
  return isDevMode() ? `${key}_${encodeURIComponent(window.location.origin)}` : key;
}

function storedToken(key: string) {
  return (
    window.localStorage.getItem(key) ??
    document.cookie
      .split('; ')
      .find((cookie) => cookie.startsWith(`${cookieKey(key)}=`))
      ?.slice(cookieKey(key).length + 1)
  );
}

function sameSession(first: string, second: string | undefined) {
  const firstIdentity = tokenIdentity(first);
  const secondIdentity = second === undefined ? undefined : tokenIdentity(second);
  return (
    firstIdentity !== undefined &&
    secondIdentity !== undefined &&
    firstIdentity.uid === secondIdentity.uid &&
    firstIdentity.gen === secondIdentity.gen
  );
}

function tokenIdentity(token: string) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return;
    const decoded: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!decoded || typeof decoded !== 'object' || !('uid' in decoded) || !('gen' in decoded)) return;
    const { uid, gen } = decoded;
    if (Number.isSafeInteger(uid) && Number.isSafeInteger(gen)) return { uid, gen };
  } catch {
    // This only chooses a local candidate; refresh verifies the token.
  }
  return undefined;
}

function findOwnProfile(data: unknown, uid: number): Partial<User & MeResponse> | undefined {
  if (!data || typeof data !== 'object') return;
  if (
    'uid' in data &&
    data.uid === uid &&
    ('gender' in data || 'avatarUrl' in data || 'name' in data || 'username' in data)
  )
    return data as Partial<User & MeResponse>;
  for (const value of Array.isArray(data) ? data : Object.values(data)) {
    const profile = findOwnProfile(value, uid);
    if (profile) return profile;
  }
  return;
}
