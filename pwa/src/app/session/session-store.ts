import { HttpErrorResponse } from '@angular/common/http';
import { inject, isDevMode, Service, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../generated/endpoints/auth/auth.service';
import { UsersService } from '../../generated/endpoints/users/users.service';
import type { MeResponse } from '../../generated/models';

declare const CHAHUA_DEV_TOKEN: string | undefined;

const TOKEN_KEY = 'chahua.auth.token';

@Service()
export class SessionStore {
  private readonly auth = inject(AuthService);
  private readonly users = inject(UsersService);
  readonly token = signal<string | undefined>(undefined);
  readonly user = signal<MeResponse | undefined>(undefined);
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
      this.user.set(await firstValueFrom(this.users.getMe()));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) this.logout();
      throw error;
    }
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
