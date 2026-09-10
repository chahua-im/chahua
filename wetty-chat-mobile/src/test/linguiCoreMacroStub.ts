// Test stand-in for "@lingui/core/macro" (see vitest.config.ts): identity
// template tag, so tests render source text without the macro compiler.
export const t = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  strings.reduce((text, part, i) => (i === 0 ? part : `${text}${values[i - 1]}${part}`), '');
