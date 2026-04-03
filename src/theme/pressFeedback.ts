import type { ViewStyle } from 'react-native';

export type PressFeedbackTone = 'subtle' | 'default' | 'strong';

const SUBTLE_FEEDBACK: ViewStyle = {
  opacity: 0.92,
  transform: [{ scale: 0.99 }],
};

const DEFAULT_FEEDBACK: ViewStyle = {
  opacity: 0.86,
  transform: [{ scale: 0.98 }],
};

const STRONG_FEEDBACK: ViewStyle = {
  opacity: 0.8,
  transform: [{ scale: 0.97 }],
};

export const pressFeedback = (pressed: boolean, tone: PressFeedbackTone = 'default') => {
  if (!pressed) return null;
  if (tone === 'subtle') return SUBTLE_FEEDBACK;
  if (tone === 'strong') return STRONG_FEEDBACK;
  return DEFAULT_FEEDBACK;
};
