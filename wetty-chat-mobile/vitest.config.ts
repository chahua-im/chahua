import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __API_BASE__: JSON.stringify('http://localhost'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    reporters: ['default', ['junit', { outputFile: 'test_output/report.xml' }]],
  },
});
