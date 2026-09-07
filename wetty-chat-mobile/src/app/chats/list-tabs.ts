import type { ActivatedRouteSnapshot } from '@angular/router';
export enum ListTab {
  Messages = 'messages',
  Groups = 'groups',
  Friends = 'friends',
  Threads = 'threads',
}

export function isListTab(value: unknown): value is ListTab {
  return (
    value === ListTab.Messages || value === ListTab.Groups || value === ListTab.Friends || value === ListTab.Threads
  );
}

export interface ListSelection {
  tab: ListTab;
  archived: boolean;
  requestHistory: boolean;
}

/** Interpret navigation at the layout boundary, outside the reusable list. */
export function listSelection(route: ActivatedRouteSnapshot): ListSelection | undefined {
  while (route.firstChild) route = route.firstChild;
  const tab = route.params['tab'] ?? route.data['tab'];
  return isListTab(tab)
    ? { tab, archived: route.data['archived'] === true, requestHistory: route.data['requestHistory'] === true }
    : undefined;
}
