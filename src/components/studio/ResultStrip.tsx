import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { colors, font, s, hairline } from '../../theme/tokens';

export default function ResultStrip({
  results,
  onSelect,
  onSave,
}: {
  results: string[];
  onSelect: (uri: string) => void;
  onSave: (uri: string) => void;
}) {
  if (!results?.length) return null;
  return (
    <View style={{ marginTop: s(6) }}>
      <Text style={[font.h2, { color: colors.text, marginBottom: s(2) }]}>Recent results</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: s(2) }}>
        {results.map((u, i) => (
          <Pressable key={u + i} onPress={() => onSelect(u)} style={styles.item}>
            <ExpoImage source={{ uri: u }} style={styles.thumb} contentFit="cover" transition={120} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const TH = 96;

const styles = StyleSheet.create({
  item: {
    height: TH, width: Math.round(TH * 0.75),
    borderRadius: 12, overflow: 'hidden',
    backgroundColor: '#EFEFF4',
    borderWidth: hairline, borderColor: 'rgba(0,0,0,0.08)',
  },
  thumb: { width: '100%', height: '100%' },
});