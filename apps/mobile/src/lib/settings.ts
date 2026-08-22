/**
 * Local connection preferences.
 *
 * The address and polling cadence are ordinary preferences. The development
 * key is kept in SecureStore on native platforms and only falls back to
 * AsyncStorage for the web preview.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { FALLBACK_BASE_URL, normalizeBaseUrl } from './api';

export const DEFAULT_BASE_URL = FALLBACK_BASE_URL;
export const DEFAULT_DEV_KEY = '';
export const POLL_OPTIONS = [15, 60, 240] as const;
export type PollMinutes = (typeof POLL_OPTIONS)[number];

const K_BASE_URL = 'awp.mobile.baseUrl';
const K_POLL_MINUTES = 'awp.mobile.pollMinutes';
const DEV_KEY_STORE = 'awp_control_plane_dev_key';

export type Settings = {
  baseUrl: string;
  devKey: string;
  pollMinutes: PollMinutes;
};

function coercePollMinutes(raw: string | null): PollMinutes {
  const value = Number(raw);
  return (POLL_OPTIONS as readonly number[]).includes(value)
    ? (value as PollMinutes)
    : 60;
}

async function loadDevKey(): Promise<string> {
  try {
    const value =
      Platform.OS === 'web'
        ? await AsyncStorage.getItem(DEV_KEY_STORE)
        : await SecureStore.getItemAsync(DEV_KEY_STORE);
    return value ?? DEFAULT_DEV_KEY;
  } catch {
    return DEFAULT_DEV_KEY;
  }
}

async function saveDevKey(devKey: string): Promise<void> {
  const value = devKey.trim();
  if (Platform.OS === 'web') {
    if (value) await AsyncStorage.setItem(DEV_KEY_STORE, value);
    else await AsyncStorage.removeItem(DEV_KEY_STORE);
    return;
  }
  if (value) await SecureStore.setItemAsync(DEV_KEY_STORE, value);
  else await SecureStore.deleteItemAsync(DEV_KEY_STORE);
}

export async function loadSettings(): Promise<Settings> {
  const [baseUrl, pollRaw, devKey] = await Promise.all([
    AsyncStorage.getItem(K_BASE_URL),
    AsyncStorage.getItem(K_POLL_MINUTES),
    loadDevKey(),
  ]);
  let safeBaseUrl = DEFAULT_BASE_URL;
  if (baseUrl) {
    try {
      safeBaseUrl = normalizeBaseUrl(baseUrl);
    } catch {
      // Ignore an invalid persisted origin and fail closed to loopback.
    }
  }
  return {
    baseUrl: safeBaseUrl,
    devKey,
    pollMinutes: coercePollMinutes(pollRaw),
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  await Promise.all([
    AsyncStorage.setItem(K_BASE_URL, baseUrl),
    AsyncStorage.setItem(K_POLL_MINUTES, String(settings.pollMinutes)),
    saveDevKey(settings.devKey),
  ]);
}
