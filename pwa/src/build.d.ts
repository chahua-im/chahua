declare const CHAHUA_APP_VERSION: string;

interface Window {
  chahuaUpdates?: {
    latestVersion?: string;
    setInteractive(value: boolean): void;
  };
}
