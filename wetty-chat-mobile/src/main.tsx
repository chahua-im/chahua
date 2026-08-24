/* Core CSS required for Ionic components to work properly */
import '@ionic/react/css/core.css';

/* Basic CSS for apps built with Ionic */
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';

/* Optional CSS utils that can be commented out */
import '@ionic/react/css/padding.css';
import '@ionic/react/css/float-elements.css';
import '@ionic/react/css/text-alignment.css';
import '@ionic/react/css/text-transformation.css';
import '@ionic/react/css/flex-utils.css';
import '@ionic/react/css/display.css';
import '@ionic/react/css/palettes/dark.system.css';

import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { I18nProvider } from '@lingui/react';
import { activateDetectedLocale, i18n } from '@/i18n';
import { createStore, setStoreInstance } from '@/store/index';
import { kvDelete, kvGet, kvSet } from '@/utils/db';
import {
  hasLegacyChatListSettings,
  hydrateSettings,
  serializeSettings,
  type StoredSettings,
} from '@/store/settingsSlice';
import { hydrateStickerPreferences } from '@/store/stickerPreferencesSlice';
import { installBootstrapRecoveryHandlers } from '@/bootstrapRecovery';
import { bootstrapAuth } from '@/authBootstrap';
import App from './App';
import AuthBootstrapGate from '@/components/bootstrap/AuthBootstrapGate';
import { setupIonicReact } from '@ionic/react';

setupIonicReact({
  mode: 'ios',
  swipeBackEnabled: false,
});

console.log(`Running in ${import.meta.env.MODE} mode, dev=${import.meta.env.DEV}`);
installBootstrapRecoveryHandlers();

async function bootstrap() {
  // Load persisted state from IndexedDB
  const [savedSettings, savedStickerPackOrder, savedAutoSort, savedFavoriteOrder, savedAutoSortFavorites] =
    await Promise.all([
      kvGet<StoredSettings>('settings'),
      kvGet<unknown>('stickerPackOrder'),
      kvGet<unknown>('autoSortStickerPacks'),
      kvGet<unknown>('favoriteStickerOrder'),
      kvGet<unknown>('autoSortFavoriteStickers'),
    ]);

  const settings = hydrateSettings(savedSettings);

  if (hasLegacyChatListSettings(savedSettings)) {
    await kvSet('settings', serializeSettings(settings));
  }
  const hydratedStickerPreferences = hydrateStickerPreferences(
    savedStickerPackOrder,
    savedAutoSort,
    savedFavoriteOrder,
    savedAutoSortFavorites,
  );

  if (hydratedStickerPreferences.clearPackOrder) {
    await kvDelete('stickerPackOrder');
  } else if (hydratedStickerPreferences.persistPackOrder) {
    await kvSet('stickerPackOrder', hydratedStickerPreferences.state.packOrder);
  }

  if (hydratedStickerPreferences.clearAutoSort) {
    await kvDelete('autoSortStickerPacks');
  } else if (hydratedStickerPreferences.persistAutoSort) {
    await kvSet('autoSortStickerPacks', hydratedStickerPreferences.state.autoSortEnabled);
  }

  if (hydratedStickerPreferences.clearFavoriteOrder) {
    await kvDelete('favoriteStickerOrder');
  } else if (hydratedStickerPreferences.persistFavoriteOrder) {
    await kvSet('favoriteStickerOrder', hydratedStickerPreferences.state.favoriteStickerOrder);
  }

  if (hydratedStickerPreferences.clearAutoSortFavorites) {
    await kvDelete('autoSortFavoriteStickers');
  } else if (hydratedStickerPreferences.persistAutoSortFavorites) {
    await kvSet('autoSortFavoriteStickers', hydratedStickerPreferences.state.autoSortFavoritesEnabled);
  }
  await activateDetectedLocale(settings.locale);
  const root = createRoot(document.getElementById('root')!);
  // The splash stays up until something is actually rendered, including while a
  // configured sign-in redirect is navigating away.
  const renderReady = () => {
    const store = createStore(settings, hydratedStickerPreferences.state);
    setStoreInstance(store);
    root.render(
      <Provider store={store}>
        <I18nProvider i18n={i18n}>
          <App />
        </I18nProvider>
      </Provider>,
    );
    document.getElementById('bootstrap-splash')?.remove();
  };

  const authResult = await bootstrapAuth();
  if (authResult.status === 'ready') {
    renderReady();
  } else if (authResult.status !== 'redirecting') {
    root.render(
      <I18nProvider i18n={i18n}>
        <AuthBootstrapGate initialResult={authResult} onReady={renderReady} onRedirecting={() => root.render(null)} />
      </I18nProvider>,
    );
    document.getElementById('bootstrap-splash')?.remove();
  }
}

void bootstrap();
