import { DefaultUrlSerializer, type UrlTree } from '@angular/router';
import { DetailView } from '../chats/chat-details/detail-view';

type SettingsAddress = { path: string; address: string; parent?: string; child?: string };

// Standalone addresses preserve skipped ancestors; child segments compress only visited parents.
const settingsAddresses: SettingsAddress[] = [
  { path: '/settings', address: 'settings' },
  { path: '/settings/general', address: 'general', parent: '/settings', child: 'general' },
  { path: '/settings/language', address: 'language', parent: '/settings', child: 'language' },
  { path: '/settings/privacy', address: 'privacy', parent: '/settings', child: 'privacy' },
  ...['blocked-users', 'friend-verification', 'presence', 'read-receipts'].map((name) => ({
    path: `/settings/${name}`,
    address: name,
    parent: '/settings/privacy',
    child: name,
  })),
  { path: '/settings/notifications', address: 'notifications', parent: '/settings', child: 'notifications' },
  {
    path: '/settings/notifications/:value',
    address: 'notification/:value',
    parent: '/settings/notifications',
    child: ':value',
  },
  { path: '/settings/stickers', address: 'sticker-settings', parent: '/settings', child: 'stickers' },
  { path: '/settings/stickers/:value', address: 'sticker-pack/:value', parent: '/settings/stickers', child: ':value' },
];

const views: Record<string, string> = {
  [DetailView.Info]: 'overview',
  [DetailView.Invites]: 'invites',
  [DetailView.Privacy]: 'privacy',
  [DetailView.Management]: 'management',
  image: 'images',
  video: 'videos',
  other: 'files',
};
const serializer = new DefaultUrlSerializer();
const detailPath = /^(?:profile\/\d+|chats\/chat\/\d+(?:\/thread\/\d+)?\/(?:info|invites))$/;

function match(pattern: string, value: string, prefix = false) {
  return new RegExp('^' + pattern.replace(':value', '([^/]+)') + (prefix ? '(?=/|$)' : '$')).exec(value);
}

function substitute(pattern: string, value?: string) {
  return pattern.replace(':value', value ?? '');
}

function settingsNode(path: string) {
  return settingsAddresses.find((node) => match(node.path, path));
}

export function panelIdentity(path: string) {
  return path.split('?')[0];
}

export function panelParent(path: string): string | undefined {
  const identity = panelIdentity(path);
  if (path !== identity) return identity;
  return settingsNode(path)?.parent;
}

function conversationBase(url: UrlTree) {
  const path = '/' + (url.root.children['primary']?.segments.map((part) => part.toString()).join('/') ?? '');
  return /^\/chats\/chat\/\d+(?:\/thread\/\d+)?$/.test(path) ? path : undefined;
}

function encodePath(path: string, base: string | undefined) {
  const node = settingsNode(path);
  if (node) return substitute(node.address, match(node.path, path)?.[1]);
  const url = serializer.parse(path);
  const identity = panelIdentity(path);
  if (
    detailPath.test(identity.slice(1)) &&
    Object.keys(url.queryParams).length === 1 &&
    views[url.queryParams['view']]
  ) {
    path = identity + '/' + views[url.queryParams['view']];
  }
  if (
    base &&
    path.startsWith(base + '/') &&
    /^(?:info|invites|search|message|thread)(?:\/|\?|$)/.test(path.slice(base.length + 1))
  ) {
    return path.slice(base.length + 1);
  }
  return path.slice(1);
}

function decodePath(address: string, base: string | undefined) {
  if (base && /^(?:info|invites|search|message|thread)(?:\/|\?|$)/.test(address))
    address = base.slice(1) + '/' + address;
  const separator = address.lastIndexOf('/');
  const identity = address.slice(0, separator);
  const view = Object.entries(views).find(([, name]) => name === address.slice(separator + 1))?.[0];
  if (view != null && detailPath.test(identity)) return '/' + identity + '?view=' + view;
  return '/' + address;
}

function decodeGroup(address: string, base: string | undefined): string[] {
  let node = settingsAddresses.find((item) => match(item.address, address, true));
  if (!node) return [decodePath(address, base)];
  let matched = match(node.address, address, true)!;
  const paths = [substitute(node.path, matched[1])];
  let rest = address.slice(matched[0].length);
  while (rest) {
    const parent: string = node.path;
    node = settingsAddresses.find((item) => item.parent === parent && match(item.child!, rest.slice(1), true));
    if (!node) return [decodePath(address, base)];
    matched = match(node.child!, rest.slice(1), true)!;
    paths.push(substitute(node.path, matched[1]));
    rest = rest.slice(matched[0].length + 1);
  }
  return paths;
}

const panelKinds = [
  { key: 'settings', path: /^settings(?:\/|$)/ },
  { key: 'profile', path: /^profile(?:\/|$)/ },
  { key: 'info', path: /^chats\/chat\/\d+(?:\/thread\/\d+)?\/info$/ },
  { key: 'search', path: /^chats\/chat\/\d+\/search$/ },
  { key: 'invites', path: /^chats\/chat\/\d+\/invites$/ },
  { key: 'reactions', path: /^chats\/chat\/\d+\/message\/\d+\/reactions$/ },
  { key: 'stickers', path: /^(?:chats\/chat\/\d+\/)?stickers\// },
  { key: 'sticker', path: /^sticker\// },
  { key: 'create', path: /^chats\/new$/ },
  { key: 'add-friend', path: /^chats\/add-friend$/ },
  { key: 'join', path: /^chats\/join(?:\/|$)/ },
  { key: 'media', path: /^media$/ },
];
const panelKeys = new Set(['panel', ...panelKinds.map((kind) => kind.key)]);

export function panelKey(path: string) {
  const identity = panelIdentity(path).slice(1);
  return panelKinds.find((kind) => kind.path.test(identity))?.key ?? 'panel';
}

/** One instance per kind. Existing settings ancestors move with their child. */
export function appendPanel(paths: readonly string[], path: string): string[] {
  const key = panelKey(path);
  const ancestors = new Set<string>();
  let parent = panelParent(path);
  while (parent) {
    ancestors.add(parent);
    parent = panelParent(parent);
  }
  return [
    ...paths.filter((entry) => panelKey(entry) !== key),
    ...paths.filter(
      (entry) => panelKey(entry) === key && ancestors.has(entry) && panelIdentity(entry) !== panelIdentity(path),
    ),
    path,
  ];
}

function decodeLegacy(value: string, base: string | undefined) {
  return value.startsWith('/')
    ? [value]
    : value.split('~').flatMap((group) => decodeGroup(group.replace(/%7E/gi, '~'), base));
}

function decodeParameter(key: string, value: string, base: string | undefined): string[] {
  if (key === 'panel') return decodeLegacy(value, base);
  if (key === 'settings') {
    // A leading ~ marks an explicitly recorded sparse chain from old links or skipped parents.
    if (value.startsWith('~')) return decodeLegacy(value.slice(1), base);
    return decodeGroup(value && value !== '1' ? 'settings/' + value : 'settings', base);
  }
  if (key === 'create') return ['/chats/new'];
  if (key === 'add-friend') return ['/chats/add-friend'];
  if (key === 'join') return ['/chats/join' + (value ? '/' + value : '')];
  if (key === 'reactions' && /^\d+$/.test(value)) return [decodePath('message/' + value + '/reactions', base)];
  if (value.startsWith('chats/')) return [decodePath(value, base)];
  return [decodePath(key + (value ? '/' + value : ''), base)];
}

function pathsFromParameters(parameters: Iterable<readonly [string, string]>, url: UrlTree) {
  let paths: string[] = [];
  const base = conversationBase(url);
  for (const [key, value] of parameters) {
    if (!panelKeys.has(key)) continue;
    for (const path of decodeParameter(key, value, base)) paths = appendPanel(paths, path);
  }
  return paths;
}

export function panelPaths(url: UrlTree): string[] {
  return pathsFromParameters(
    Object.entries(url.queryParams).flatMap(([key, value]: [string, string | string[]]) =>
      (Array.isArray(value) ? value : [value]).map((entry) => [key, entry] as const),
    ),
    url,
  );
}

function settingsValue(paths: readonly string[]) {
  const groups: string[] = [];
  paths.forEach((path, index) => {
    const node = settingsNode(path);
    if (index > 0 && node?.parent === paths[index - 1]) {
      groups[groups.length - 1] += '/' + substitute(node.child!, match(node.path, path)?.[1]).replace(/~/g, '%7E');
    } else groups.push(encodePath(path, undefined).replace(/~/g, '%7E'));
  });
  if (groups.length === 1 && (groups[0] === 'settings' || groups[0].startsWith('settings/')))
    return groups[0].slice('settings'.length).replace(/^\//, '');
  return '~' + groups.join('~');
}

export function clearPanelParameters(url: UrlTree) {
  url.queryParams = { ...url.queryParams };
  // Reinsert panel keys in stack order; overwriting a value would leave its old position.
  for (const key of panelKeys) delete url.queryParams[key];
}

export function setPanelPaths(url: UrlTree, paths: readonly string[]) {
  clearPanelParameters(url);
  const base = conversationBase(url);
  const normalized = paths.reduce<string[]>((chain, path) => appendPanel(chain, path), []);
  const groups = new Map<string, string[]>();
  for (const path of normalized) {
    const key = panelKey(path);
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const address = encodePath(group.at(-1)!, base);
    let value: string;
    if (key === 'settings') value = settingsValue(group);
    else if (key === 'create' || key === 'add-friend') value = '';
    else if (key === 'join') value = address.slice('chats/join'.length).replace(/^\//, '');
    else if (key === 'reactions' && /^message\/\d+\/reactions$/.test(address)) value = address.split('/')[1];
    else if (address === key) value = '';
    else value = address.startsWith(key + '/') ? address.slice(key.length + 1) : address;
    url.queryParams[key] = value;
  }
}

/** Named query parameters are ordered layers; repeated kinds keep only their latest occurrence. */
export class PanelUrlSerializer extends DefaultUrlSerializer {
  override parse(url: string): UrlTree {
    const tree = super.parse(url);
    if (Object.keys(tree.queryParams).some((key) => panelKeys.has(key))) {
      const query = url.split('#', 1)[0].split('?').slice(1).join('?');
      // Angular groups repeated keys; use their original positions before applying replacement.
      setPanelPaths(tree, pathsFromParameters(new URLSearchParams(query), tree));
    }
    return tree;
  }

  override serialize(tree: UrlTree): string {
    const url = super.serialize(tree);
    const fragment = url.indexOf('#');
    const end = fragment < 0 ? url.length : fragment;
    return (
      url
        .slice(0, end)
        .replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator: string, key: string, value: string) =>
          panelKeys.has(key) ? separator + key + (value ? '=' + value.replace(/%2F/gi, '/') : '') : match,
        ) + url.slice(end)
    );
  }
}
