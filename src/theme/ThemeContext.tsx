import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors as baseColors } from './tokens';

type ThemeMode = 'light' | 'dark';

type ThemeColors = typeof baseColors;

type ThemeContextShape = {
  mode: ThemeMode;
  isDark: boolean;
  colors: ThemeColors;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
};

const THEME_KEY = 'app.theme.mode.v1';

const ThemeContext = createContext<ThemeContextShape>({
  mode: 'light',
  isDark: false,
  colors: baseColors,
  setMode: () => {},
  toggleMode: () => {},
});

const buildColors = (mode: ThemeMode): ThemeColors => {
  if (mode === 'dark') {
    return {
      ...baseColors,
      bg: baseColors.bgDark,
      text: baseColors.textOnDark,
      textDim: 'rgba(255,255,255,0.6)',
      borderLight: 'rgba(255,255,255,0.12)',
      glassTint: baseColors.glassTintDark,
      pillBg: baseColors.pillBgDark,
    };
  }
  return {
    ...baseColors,
    bg: baseColors.bg,
    text: baseColors.text,
    textDim: baseColors.textDim,
    borderLight: baseColors.borderLight,
    glassTint: baseColors.glassTint,
    pillBg: baseColors.pillBg,
  };
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>('light');

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const stored = await AsyncStorage.getItem(THEME_KEY);
        if (!mounted || !stored) return;
        if (stored === 'dark' || stored === 'light') setModeState(stored);
      } catch {
        // ignore
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    void AsyncStorage.setItem(THEME_KEY, next);
  };

  const toggleMode = () => setMode(mode === 'dark' ? 'light' : 'dark');

  const value = useMemo(() => {
    const colors = buildColors(mode);
    return { mode, isDark: mode === 'dark', colors, setMode, toggleMode };
  }, [mode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);
