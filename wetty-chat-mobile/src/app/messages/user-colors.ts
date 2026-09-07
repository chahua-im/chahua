// The original chat's name colors, with matching light and dark palettes.
const light = ['#CA5650', '#D87B29', '#9B66DC', '#50B232', '#379EB8', '#4E92CC', '#CF5C95'];
const dark = ['#D45246', '#F68136', '#6C61DF', '#46BA43', '#5CAFFA', '#408ACF', '#D95574'];

export function userColors(name: string) {
  let hash = 0;
  for (const character of name) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  const index = Math.abs(hash) % light.length;
  return { light: light[index], dark: dark[index] };
}
