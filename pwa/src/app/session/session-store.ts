import { HttpErrorResponse } from '@angular/common/http';
import { inject, isDevMode, Service, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../generated/endpoints/auth/auth.service';
import { UsersService } from '../../generated/endpoints/users/users.service';
import type { MeResponse, User } from '../../generated/models';

declare const CHAHUA_DEV_TOKEN: string | undefined;

const TOKEN_KEY = 'chahua.auth.token';

@Service()
export class SessionStore {
  private readonly auth = inject(AuthService);
  private readonly users = inject(UsersService);
  readonly token = signal<string | undefined>(undefined);
  readonly user = signal<(MeResponse & Pick<User, 'userGroup'>) | undefined>(undefined);
  async initialize() {
    const url = new URL(window.location.href);
    const token =
      url.searchParams.get('token') ??
      window.localStorage.getItem(TOKEN_KEY) ??
      (isDevMode() && typeof CHAHUA_DEV_TOKEN !== 'undefined' ? CHAHUA_DEV_TOKEN : undefined);
    url.searchParams.delete('token');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);

    try {
      if (!token) return;
      this.saveToken(token);
      const refreshed = await firstValueFrom(this.auth.postRefresh());
      this.saveToken(refreshed.token);
      const user = await firstValueFrom(this.users.getMe());
      // /users/me omits the group tag; the existing UID lookup includes it.
      const profile = await firstValueFrom(this.users.getUserSearch({ q: String(user.uid), limit: 1 })).catch(
        () => undefined,
      );
      this.user.set({ ...user, userGroup: profile?.members.find((member) => member.uid === user.uid)?.userGroup });
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) this.logout();
      throw error;
    }
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

  logout() {
    this.saveToken(undefined);
    this.user.set(undefined);
  }

  private saveToken(token: string | undefined) {
    this.token.set(token);
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  }
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
