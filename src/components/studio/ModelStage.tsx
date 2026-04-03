import React from 'react';
import { View, StyleSheet, Platform, StyleSheet as RNStyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { Image as ExpoImage } from 'expo-image';
import { colors, hairline, s } from '../../theme/tokens';

const STAGE_R = 20;

type Props = { uri: string };

export default function ModelStage({ uri }: Props) {
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <BlurView tint="light" intensity={24} style={RNStyleSheet.absoluteFill} />
        <View style={styles.stroke} />
        <ExpoImage
          source={{ uri }}
          style={styles.img}
          contentFit="contain"
          transition={0}
          cachePolicy="memory-disk"
          priority="high"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', marginTop: s(4) },
  card: {
    width: '100%',
    maxWidth: 520,
    aspectRatio: 3 / 4,
    borderRadius: STAGE_R,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderWidth: hairline,
    borderColor: colors.borderLight,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 8 } },
      android: { elevation: 4 },
    }),
  },
  stroke: {
    ...RNStyleSheet.absoluteFillObject,
    borderRadius: STAGE_R,
    borderWidth: hairline,
    borderColor: 'rgba(255,255,255,0.9)',
    opacity: 0.55,
  },
  img: { width: '100%', height: '100%', backgroundColor: '#fff' },
});