const target = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

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
