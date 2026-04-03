import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoHaptics from 'expo-haptics';

const HAPTICS_ENABLED_KEY = 'settings.haptics.enabled.v1';
const LEGACY_SETTINGS_PREFS_KEY = 'settings.preferences.v1';

let hapticsEnabled = true;
let hapticsLoaded = false;
let loadPromise: Promise<boolean> | null = null;

type LegacySettingsPrefs = {
  app?: {
    haptics?: boolean;
  };
};

const readStoredHapticsPreference = async () => {
  try {
    const stored = await AsyncStorage.getItem(HAPTICS_ENABLED_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;

    const legacyRaw = await AsyncStorage.getItem(LEGACY_SETTINGS_PREFS_KEY);
    if (!legacyRaw) return hapticsEnabled;

    const legacy = JSON.parse(legacyRaw) as LegacySettingsPrefs;
    if (typeof legacy?.app?.haptics === 'boolean') {
      await AsyncStorage.setItem(HAPTICS_ENABLED_KEY, JSON.stringify(legacy.app.haptics)).catch(() => {});
      return legacy.app.haptics;
    }
  } catch {
    // ignore storage failures and keep the in-memory default
  }

  return hapticsEnabled;
};

export const ensureHapticsPreferenceLoaded = async () => {
  if (hapticsLoaded) return hapticsEnabled;
  if (!loadPromise) {
    loadPromise = (async () => {
      const stored = await readStoredHapticsPreference();
      hapticsEnabled = stored;
      hapticsLoaded = true;
      loadPromise = null;
      return stored;
    })();
  }
  return loadPromise;
};

export const setHapticsEnabled = async (enabled: boolean) => {
  hapticsEnabled = enabled;
  hapticsLoaded = true;
  loadPromise = null;
  try {
    await AsyncStorage.setItem(HAPTICS_ENABLED_KEY, JSON.stringify(enabled));
  } catch {
    // ignore storage failures
  }
};

const runIfEnabled = async (callback: () => Promise<void>) => {
  const enabled = await ensureHapticsPreferenceLoaded();
  if (!enabled) return;
  try {
    await callback();
  } catch {
    // ignore haptics failures
  }
};

export const selectionAsync = () => runIfEnabled(() => ExpoHaptics.selectionAsync());

export const impactAsync = (
  style: ExpoHaptics.ImpactFeedbackStyle = ExpoHaptics.ImpactFeedbackStyle.Light
) => runIfEnabled(() => ExpoHaptics.impactAsync(style));

export const notificationAsync = (
  type: ExpoHaptics.NotificationFeedbackType = ExpoHaptics.NotificationFeedbackType.Success
) => runIfEnabled(() => ExpoHaptics.notificationAsync(type));

export const areHapticsEnabled = () => hapticsEnabled;
export const Haptics = ExpoHaptics;
