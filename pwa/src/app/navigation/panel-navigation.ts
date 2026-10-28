import { DOCUMENT, Location } from '@angular/common';
import { computed, inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, RedirectCommand, Router, type CanActivateFn } from '@angular/router';
import { filter, map } from 'rxjs';

import { panelDefinition, PanelKind } from './panel-definitions';
import { appendPanel, clearPanelParameters, panelIdentity, panelParent, panelPaths, setPanelPaths } from './panel-url';
export { panelIdentity, panelPaths } from './panel-url';

@Service()
export class PanelNavigation {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly document = inject(DOCUMENT);
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  readonly paths = computed(() => panelPaths(this.router.parseUrl(this.currentUrl())));
  readonly largeScreen = signal(false);
  readonly sidebar = computed(
    () => this.largeScreen() && this.paths().length === 1 && panelDefinition(this.paths()[0])?.kind === PanelKind.Info,
  );
  readonly covered = computed(() => this.paths().length > 0 && !this.sidebar());
  readonly media = computed(() => panelDefinition(this.paths().at(-1) ?? '')?.kind === PanelKind.Media);
  readonly state = signal<Record<string, unknown>>(this.location.getState() as Record<string, unknown>);
  private readonly leaveChecks = new Map<string, () => boolean | Promise<boolean>>();
  private closing = false;

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationEnd) this.state.set(this.location.getState() as Record<string, unknown>);
    });
  }

  registerLeaveCheck(path: string, check: () => boolean | Promise<boolean>) {
    this.leaveChecks.set(path, check);
    return () => this.leaveChecks.delete(path);
  }

  async canNavigate(next: string) {
    const navigation = this.router.currentNavigation();
    const closing = this.closing && navigation?.trigger === 'popstate';
    this.closing = false;
    if (navigation?.trigger === 'popstate') {
      const overlays = this.document.querySelectorAll<
        HTMLIonModalElement | HTMLIonPopoverElement | HTMLIonAlertElement | HTMLIonActionSheetElement
      >(
        'ion-modal:not(.route-panel):not(.overlay-hidden), ion-popover:not(.overlay-hidden), ion-alert:not(.overlay-hidden), ion-action-sheet:not(.overlay-hidden)',
      );
      const top = Array.from(overlays)
        .filter((overlay) => overlay.overlayIndex > 0)
        .at(-1);
      if (top) {
        await top.dismiss(undefined, 'back');
        return false;
      }
    }
    const before = this.paths();
    const target = this.router.parseUrl(next);
    if (closing) clearPanelParameters(target);
    const after = panelPaths(target);
    const retained = new Set(after.map(panelIdentity));
    // Replacement can remove a covered form while another kind remains at the front.
    for (const path of [...before].reverse()) {
      const leavingTop = path === before.at(-1) && path !== after.at(-1);
      if (
        (leavingTop || !retained.has(panelIdentity(path))) &&
        (await this.leaveChecks.get(panelIdentity(path))?.()) === false
      )
        return false;
    }
    // A copied link can already contain panels at the beginning of this history flow.
    // Redirect before activation so closing never briefly reveals that original chain.
    if (closing && this.router.serializeUrl(target) !== next) {
      return new RedirectCommand(target, {
        replaceUrl: true,
        state: { ...navigation?.extras.state, panelDepth: 0 },
      });
    }
    return true;
  }

  /** Legacy/shareable URLs enter a panel without activating a different primary page. */
  redirect(path: string) {
    const navigation = this.router.currentNavigation();
    const current = this.router.parseUrl(this.router.url);
    const hasSource = this.router.navigated;
    const target = hasSource ? current : this.router.parseUrl(this.fallback(path));
    const paths = hasSource ? panelPaths(current) : [];
    if (!paths.length) {
      const parents: string[] = [];
      let parent = panelParent(path);
      while (parent) {
        parents.unshift(parent);
        parent = panelParent(parent);
      }
      paths.push(...parents);
    }
    setPanelPaths(target, appendPanel(paths, path));
    return new RedirectCommand(target, {
      replaceUrl: !hasSource || navigation?.extras.replaceUrl,
      state: {
        ...(hasSource ? (this.location.getState() as object) : {}),
        ...navigation?.extras.state,
        panelDepth: hasSource ? this.depth() + (navigation?.extras.replaceUrl ? 0 : 1) : 0,
      },
    });
  }

  updatePage(view: string | number) {
    return this.setPage(this.paths().at(-1), view);
  }

  replacePage(path: string, view: string | number) {
    return this.setPage(path, view, true);
  }

  private setPage(path: string | undefined, view: string | number, replaceUrl = false) {
    const paths = [...this.paths()];
    const index = paths.findIndex((entry) => path != null && panelIdentity(entry) === panelIdentity(path));
    if (index < 0) return Promise.resolve(false);
    const url = this.router.parseUrl(paths[index]);
    url.queryParams = { ...url.queryParams, view };
    paths[index] = this.router.serializeUrl(url);
    return this.navigate(paths, replaceUrl, this.depth() + (replaceUrl ? 0 : 1));
  }

  back() {
    if (this.depth() > 0) {
      this.location.back();
      return Promise.resolve(true);
    }
    const paths = [...this.paths()];
    const last = paths.pop();
    // The URL already contains the actual settings ancestors. Only an internal detail view
    // needs its own overview restored; inserting semantic parents here changes the source chain.
    if (last && last !== panelIdentity(last)) paths.push(panelIdentity(last));
    return this.navigate(paths, true);
  }

  close() {
    if (this.media()) return this.back();
    if (this.depth() > 0) {
      if (this.closing) return Promise.resolve(true);
      this.closing = true;
      this.location.historyGo(-this.depth());
      return Promise.resolve(true);
    }
    return this.navigate([], true);
  }

  private depth() {
    return this.paths().length ? Number((this.location.getState() as { panelDepth?: number }).panelDepth ?? 0) : 0;
  }

  private navigate(paths: string[], replaceUrl = false, depth = replaceUrl ? 0 : this.depth() + 1) {
    const url = this.router.parseUrl(this.router.url);
    setPanelPaths(url, paths);
    return this.router.navigateByUrl(url, {
      replaceUrl,
      state: { ...(this.location.getState() as object), panelDepth: depth },
    });
  }

  private fallback(path: string) {
    return /^\/chats\/chat\/\d+(?:\/thread\/\d+)?/.exec(path)?.[0] ?? '/chats';
  }

  /** Called only after a successful destination navigation. Route panels follow the URL. */
  async dismissTransientOverlays() {
    const overlays = this.document.querySelectorAll<
      HTMLIonModalElement | HTMLIonPopoverElement | HTMLIonAlertElement | HTMLIonActionSheetElement
    >('ion-modal:not(.route-panel), ion-popover, ion-alert, ion-action-sheet');
    await Promise.all(Array.from(overlays, (overlay) => overlay.dismiss(undefined, 'navigate')));
  }
}

export const openPanel: CanActivateFn = (route, state) => {
  const router = inject(Router);
  const target = router.parseUrl(state.url);
  clearPanelParameters(target);
  if (route.routeConfig?.path === 'profile' && target.queryParams['uid']) {
    return inject(PanelNavigation).redirect('/profile/' + target.queryParams['uid']);
  }
  return inject(PanelNavigation).redirect(router.serializeUrl(target));
};

export const canNavigatePanels: CanActivateFn = (_route, state) => inject(PanelNavigation).canNavigate(state.url);
