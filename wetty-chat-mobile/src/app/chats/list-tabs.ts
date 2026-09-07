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
