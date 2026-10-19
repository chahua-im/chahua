import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dart,
  diff,
  go,
  java,
  javascript,
  json,
  kotlin,
  python,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, grammar] of Object.entries(languages)) hljs.registerLanguage(name, grammar);

/** Only highlight explicitly supported languages; unlabelled code stays plain. */
export function highlightCodeBlock(element: HTMLElement): void {
  const language = /\blanguage-([\w+-]+)/i.exec(element.className)?.[1];
  if (language && hljs.getLanguage(language)) hljs.highlightElement(element);
}
