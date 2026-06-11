import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.base';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

const keyPath = path.resolve(__dirname, './dev-certs/key.pem');
const certPath = path.resolve(__dirname, './dev-certs/cert.pem');
const httpsConfig =
  fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      }
    : undefined;

export default mergeConfig(
  baseConfig,
  defineConfig({
    define: {
      __APP_VERSION__: JSON.stringify('development'),
      __FEATURE_GATES_ENABLED__: JSON.stringify(true),
    },
    server: {
      host: true,
      https: httpsConfig,
      proxy: {
        // WebSocket: must be more specific than /_api/ so it matches first
        '/_api/ws': {
          target: API_PROXY_TARGET,
          ws: true,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/_api/, ''),
        },
        '^/_api/': {
          target: API_PROXY_TARGET,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/_api/, ''),
        },
      },
    },
  }),
);
