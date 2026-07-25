import axios, { HttpStatusCode } from 'axios';
import { getOrCreateClientId } from '@/utils/clientId';
import { getStoredJwtToken } from '@/utils/jwtToken';

/**
 * Base URL for API requests.
 * - Development: /_api (same-origin; Vite proxies to backend at localhost:3000).
 * - Production: VITE_API_BASE_URL (must be set in build env).
 */

const apiClient = axios.create({ baseURL: __API_BASE__ });

apiClient.interceptors.request.use((config) => {
  config.headers['X-App-Version'] = __APP_VERSION__;
  const jwtToken = getStoredJwtToken();
  if (jwtToken) {
    config.headers.Authorization = `Bearer ${jwtToken}`;
  } else {
    // Only send X-Client-Id when there's no JWT (JWT already carries cid)
    config.headers['X-Client-Id'] = getOrCreateClientId();
  }
  return config;
});

if (import.meta.env.PROD && __AUTH_REDIRECT_URL__) {
  apiClient.interceptors.response.use(
    (fulfilled) => {
      return fulfilled;
    },
    (error) => {
      if (error.response?.status === HttpStatusCode.Unauthorized) {
        window.location.href = __AUTH_REDIRECT_URL__;
      }
      return Promise.reject(error);
    },
  );
}

export default apiClient;
