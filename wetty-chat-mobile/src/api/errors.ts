import axios from 'axios';

/**
 * Unwraps a failed API call to a user-facing string, surfacing the backend
 * error text directly. Deliberately does NOT map specific backend messages:
 * a structured error-code contract is tracked separately.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (typeof data === 'string' && data) return data;
    if (error.message) return error.message;
  } else if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
