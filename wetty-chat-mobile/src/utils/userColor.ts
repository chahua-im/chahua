/**
 * User display color configuration.
 *
 * To adjust the overall color sets: edit USER_COLOR_PALETTE_LIGHT / _DARK.
 * Array lengths may differ; the hash is taken modulo the active palette length.
 */

/** Light-mode palette for users not in the override map. Indexed by name hash. */
const USER_COLOR_PALETTE_LIGHT: string[] = [
  '#CA5650', // Red
  '#D87B29', // Orange
  '#9B66DC', // Violet
  '#50B232', // Green
  '#379EB8', // Cyan
  '#4E92CC', // Blue
  '#CF5C95', // Pink
];

/** Dark-mode palette for users not in the override map. Indexed by name hash. */
const USER_COLOR_PALETTE_DARK: string[] = [
  '#D45246', // Red
  '#F68136', // Orange
  '#6C61DF', // Violet
  '#46BA43', // Green
  '#5CAFFA', // Cyan
  '#408ACF', // Blue
  '#D95574', // Pink
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
 * @param dark select the dark-mode palette when true (pass `useIsDarkMode()` from React)
 */
export function colorForUser(name: string, dark: boolean): string {
  const palette = dark ? USER_COLOR_PALETTE_DARK : USER_COLOR_PALETTE_LIGHT;
  return palette[hashName(name) % palette.length];
}
