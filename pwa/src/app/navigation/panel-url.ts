import { DefaultUrlSerializer, type UrlTree } from '@angular/router';
import {
  hasPanelViews,
  panelDefinition,
  panelDefinitions,
  PanelKind,
  panelParameterAddresses,
  panelViews,
} from './panel-definitions';

// Standalone addresses preserve skipped ancestors; child segments compress only visited parents.
const settingsAddresses = panelDefinitions.flatMap((definition) =>
  definition.settings ? [{ path: '/' + definition.path, ...definition.settings }] : [],
);
const serializer = new DefaultUrlSerializer();

function match(pattern: string, value: string, prefix = false) {
  return new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + (prefix ? '(?=/|$)' : '$')).exec(value);
}

function substitute(pattern: string, value?: string) {
  return pattern.replace(/:\w+/g, () => value ?? '');
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
  if (hasPanelViews(identity) && Object.keys(url.queryParams).length === 1 && panelViews[url.queryParams['view']]) {
    path = identity + '/' + panelViews[url.queryParams['view']];
  }
  if (base && path.startsWith(base + '/') && panelDefinition(identity)?.conversation) {
    return path.slice(base.length + 1);
  }
  return path.slice(1);
}

function decodePath(address: string, base: string | undefined) {
  if (
    base &&
    (panelDefinition(base + '/' + address)?.conversation ||
      hasPanelViews(base + '/' + address.slice(0, address.lastIndexOf('/'))))
  )
    address = base.slice(1) + '/' + address;
  const separator = address.lastIndexOf('/');
  const identity = address.slice(0, separator);
  const view = Object.entries(panelViews).find(([, name]) => name === address.slice(separator + 1))?.[0];
  if (view != null && hasPanelViews(identity)) return '/' + identity + '?view=' + view;
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

const panelKeys = new Set<string>(['panel', ...Object.values(PanelKind)]);

export function panelKey(path: string) {
  return panelDefinition(path)?.kind ?? 'panel';
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
  if (key === PanelKind.Settings) {
    // A leading ~ marks an explicitly recorded sparse chain from old links or skipped parents.
    if (value.startsWith('~')) return decodeLegacy(value.slice(1), base);
    return decodeGroup(value && value !== '1' ? 'settings/' + value : 'settings', base);
  }
  const compact = panelParameterAddresses[key as PanelKind];
  if (compact && (!compact.numeric || /^\d+$/.test(value)))
    return [decodePath(substitute(compact.path, value).replace(/\/$/, ''), base)];
  const path = decodePath(value, base);
  if (value.startsWith('chats/') || panelDefinition(path)?.conversation) return [path];
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
    if (key === PanelKind.Settings) value = settingsValue(group);
    else if (panelParameterAddresses[key as PanelKind]) {
      const compact = panelParameterAddresses[key as PanelKind]!;
      const matched = match(compact.path, address);
      value = matched ? (matched[1] ?? '') : address === compact.path.replace(/\/:\w+$/, '') ? '' : address;
    } else if (address === key) value = '';
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
