declare const CHAHUA_APP_VERSION: string;
declare const CHAHUA_API_BASE: string;

interface Window {
  chahuaStartup?: {
    finish(): void;
    fail(): void;
  };
  chahuaUpdates?: {
    latestVersion?: string;
    setInteractive(value: boolean): void;
  };
}
