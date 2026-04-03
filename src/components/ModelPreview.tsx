import React from 'react';
import { StyleSheet, View } from 'react-native';
import Glass from './Glass';
import { s } from '../theme/tokens';
import { Image } from 'expo-image';

type Props = {
  uri: string;
};

export default function ModelPreview({ uri }: Props) {
  return (
    <Glass style={styles.card}>
      <Image
        source={{ uri }}
        style={styles.img}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
    </Glass>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 140, // "small left" visual
    height: 260,
    justifyContent: 'center',
    alignItems: 'center',
  },
  img: { width: '100%', height: '100%', borderRadius: s(4) },
});
