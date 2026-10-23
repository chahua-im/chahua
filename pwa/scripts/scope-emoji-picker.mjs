import { readFile, writeFile } from 'node:fs/promises';
import postcss from 'postcss';

// 2.3.6 ships Tailwind preflight and utilities with ViewEncapsulation.None.
// Scope both Angular style declarations without changing the component's DOM/events.
const packageFile = new URL('../node_modules/@nicematic/emoji-picker/package.json', import.meta.url);
const { version, module: modulePath } = JSON.parse(await readFile(packageFile, 'utf8'));
if (version !== '2.3.6')
  throw new Error('Review emoji picker style isolation before upgrading @nicematic/emoji-picker.');

const moduleFile = new URL(modulePath, packageFile);
const source = await readFile(moduleFile, 'utf8');
const marker = '// chahua: nicematic styles scoped to picker\n';
if (!source.startsWith(marker)) {
  let count = 0;
  const scoped = source.replace(/styles: \[("(?:[^"\\]|\\.)*")\]/g, (_, literal) => {
    const css = postcss.parse(JSON.parse(literal));
    css.walkRules((rule) => {
      if (rule.parent.type === 'atrule' && rule.parent.name.endsWith('keyframes')) return;
      rule.selectors = rule.selectors.map((selector) => {
        if (selector === ':root' || selector === ':host' || selector === 'html') return 'nicematic-picker';
        if (selector === 'nicematic-picker') return selector;
        return `:where(nicematic-picker) ${selector}`;
      });
    });
    count++;
    return `styles: [${JSON.stringify(css.toString())}]`;
  });
  if (count !== 2) throw new Error(`Expected two emoji picker style declarations, found ${count}.`);
  await writeFile(moduleFile, marker + scoped);
}
