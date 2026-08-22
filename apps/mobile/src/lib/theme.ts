/** Calm light/dark palettes + status badge colors. */
import { useColorScheme } from 'react-native';

export type Theme = {
  dark: boolean;
  bg: string;
  card: string;
  cardAlt: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  chipBg: string;
  navBg: string;
  /** Shadow color used to lift cards off the background. */
  shadow: string;
  /** Shadow opacity tuned per scheme (subtle in light, deeper in dark). */
  shadowOpacity: number;
};

const light: Theme = {
  dark: false,
  // A touch deeper than the cards so white surfaces visibly float.
  bg: '#EAEEF4',
  card: '#FFFFFF',
  cardAlt: '#F7F9FC',
  // Softer border — the shadow now carries the separation.
  border: '#E6EAF1',
  text: '#11161F',
  textDim: '#4A5468',
  textFaint: '#8A94A6',
  accent: '#2F6BFF',
  chipBg: '#EAEFF8',
  navBg: '#FFFFFF',
  shadow: '#0B1220',
  shadowOpacity: 0.08,
};

const dark: Theme = {
  dark: true,
  bg: '#0B1220',
  card: '#141C2B',
  cardAlt: '#1B2435',
  border: '#26314A',
  text: '#E8EEF9',
  textDim: '#A7B4CC',
  textFaint: '#6C7A95',
  accent: '#5E96FF',
  chipBg: '#1B2740',
  navBg: '#0E1626',
  shadow: '#000000',
  shadowOpacity: 0.35,
};

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? dark : light;
}

export function getTheme(scheme: 'light' | 'dark' | 'unspecified' | null | undefined): Theme {
  return scheme === 'dark' ? dark : light;
}

/** Badge color for a design/conversation status. */
export function statusColors(
  status: string | null | undefined,
  t: Theme,
): { bg: string; fg: string } {
  const s = (status || '').toLowerCase();
  if (s.includes('infeasible')) return { bg: '#F59E0B', fg: '#241600' };
  if (s.includes('success') || s.includes('passed') || s.includes('ok'))
    return { bg: '#22C55E', fg: '#04210F' };
  if (s.includes('fail') || s.includes('error') || s.includes('abort'))
    return { bg: '#EF4444', fg: '#2A0606' };
  // review statuses / unknown → neutral
  return { bg: t.dark ? '#334063' : '#C7D0E0', fg: t.dark ? '#DCE6F8' : '#1B2333' };
}
