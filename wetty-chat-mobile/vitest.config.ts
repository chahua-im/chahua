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
