import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __API_BASE__: JSON.stringify('http://localhost'),
    __FEATURE_GATES_ENABLED__: JSON.stringify(false),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Run lingui macros as identity helpers in tests, so the macro compiler
      // and its optional peer "babel-plugin-macros" (missing on clean CI
      // installs) never load. One stub per specifier: some tests vi.mock
      // these two specifiers independently.
      '@lingui/core/macro': path.resolve(__dirname, './src/test/linguiCoreMacroStub.ts'),
      '@lingui/react/macro': path.resolve(__dirname, './src/test/linguiReactMacroStub.ts'),
    },
  },
  test: {
    reporters: ['default', ['junit', { outputFile: 'test_output/report.xml' }]],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: ['src/**/*.dom.test.ts', 'src/**/*.dom.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['src/**/*.dom.test.ts', 'src/**/*.dom.test.tsx'],
          setupFiles: ['src/test/domSetup.ts'],
        },
      },
    ],
  },
});
