declare const CHAHUA_APP_VERSION: string;
declare const CHAHUA_API_BASE: string;

interface Window {
  chahuaUpdates?: {
    latestVersion?: string;
    setInteractive(value: boolean): void;
  };
}
