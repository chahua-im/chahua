const target = process.env.API_PROXY_TARGET;
if (!target) throw new Error('Start the PWA through node runspace/dev.mjs pwa or npm start.');

const rewrite = (path) => path.replace(/^\/_api/, '');

export default {
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
