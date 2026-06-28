/**
 * User display color configuration.
 *
 * Resolution order (highest first):
 *   1. USER_COLOR_OVERRIDES — explicit username → color mapping
 *   2. USER_COLOR_PALETTE   — fixed palette, indexed by name hash
 *
 * To pin a specific user's color: add an entry to USER_COLOR_OVERRIDES
 *   'username': '#rrggbb'
 * This color applies regardless of light/dark mode.
 *
 * To adjust the overall color set: edit USER_COLOR_PALETTE.
 * Array length is arbitrary; the hash is taken modulo its length.
 */

/** Manual override map: username (case-sensitive) → color. Hits skip the hash. */
const USER_COLOR_OVERRIDES: Record<string, string> = {
  // Examples:
  // 'admin': '#ff0000',
  // 'Alice': '#3cb4f0',
};

/** Color palette for users not in the override map. Indexed by name hash. */
const USER_COLOR_PALETTE: string[] = [
  '#D95574',
  '#17becf',
  '#D45246',
  '#5CAFFA',
  '#F68136',
  '#408ACF',
  '#46BA43',
  '#6C61DF',
  '#4db6ac',
];

function hashName(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Resolve a user's display color.
 *
 * @param name username
 */
export function colorForUser(name: string): string {
  const override = USER_COLOR_OVERRIDES[name];
  if (override) return override;

  return USER_COLOR_PALETTE[hashName(name) % USER_COLOR_PALETTE.length];
}
