const target = process.env.API_PROXY_TARGET;
if (!target) throw new Error('Start the PWA through node runspace/dev.mjs pwa or npm start.');

const rewrite = (path) => path.replace(/^\/_api/, '');
const storageTarget = process.env.STORAGE_PROXY_TARGET;

export default {
  ...(storageTarget
    ? {
        '^/_storage/': {
          target: storageTarget,
          // The backend signs with the internal endpoint's Host, including its port.
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/_storage/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (request) => {
              request.removeHeader('cookie');
              request.removeHeader('authorization');
            });
          },
        },
      }
    : {}),
  '^/_api/ws': {
    target,
    changeOrigin: true,
    ws: true,
    rewrite,
  },
  '^/_api': {
    target,
    changeOrigin: true,
    rewrite,
  },
};
