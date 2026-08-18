import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const projectRoot = path.resolve(import.meta.dirname, '..');
const sourceDirectory = path.join(projectRoot, 'src');

async function findCssModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return findCssModules(entryPath);
      }

      return entry.name.endsWith('.module.scss') ? [entryPath] : [];
    }),
  );

  return files.flat();
}

const server = await createServer({
  root: projectRoot,
  configFile: path.join(projectRoot, 'vite.config.base.ts'),
  server: {
    middlewareMode: true,
  },
  appType: 'custom',
});

try {
  const cssModules = await findCssModules(sourceDirectory);

  for (const cssModule of cssModules) {
    const requestPath = `/${path.relative(projectRoot, cssModule).split(path.sep).join('/')}`;
    await server.transformRequest(requestPath);
  }
} finally {
  await server.close();
}
