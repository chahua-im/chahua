import { defineConfig, mergeConfig } from 'vite';
import { createBaseConfig } from './vite.config.base';

const ASSET_URL = 'https://chahui.app';
const ASSET_BASE = `${ASSET_URL}/assets`;
const API_BASE_URL = `${ASSET_URL}/_api`;

export default mergeConfig(
  createBaseConfig({ assetBaseUrl: ASSET_BASE }),
  defineConfig({
    experimental: {
      renderBuiltUrl(filename, { type }) {
        if (type === 'public') {
          return `/${filename}`;
        }

        return `${ASSET_URL}/${filename}`;
      },
    },
    define: {
      __ASSET_BASE__: JSON.stringify(ASSET_BASE),
      __API_BASE__: JSON.stringify(API_BASE_URL),
      __FEATURE_GATES_ENABLED__: JSON.stringify(false),
    },
  }),
);
