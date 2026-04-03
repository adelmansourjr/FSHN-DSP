import React, { useMemo } from 'react';
import {
  Modal,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  View,
  Text,
  ScrollView,
  TextInput,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { font, s } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import type { LocalClosetItem } from '../../lib/localCloset';

type Props = {
  visible: boolean;
  editingItem: LocalClosetItem | null;
  saving: boolean;
  categories: readonly string[];
  categoryDraft: string;
  brandDraft: string;
  colorDraft: string;
  tagDraft: string;
  suggestedTags: string[];
  draftTags: string[];
  onClose: () => void;
  onSetCategoryDraft: (value: string) => void;
  onSetBrandDraft: (value: string) => void;
  onSetColorDraft: (value: string) => void;
  onSetTagDraft: (value: string) => void;
  onToggleSuggestedTag: (tag: string) => void;
  onClearTags: () => void;
  onRemove: (item: LocalClosetItem) => void;
  onSave: () => void;
};

export default function ClosetEditorModal({
  visible,
  editingItem,
  saving,
  categories,
  categoryDraft,
  brandDraft,
  colorDraft,
  tagDraft,
  suggestedTags,
  draftTags,
  onClose,
  onSetCategoryDraft,
  onSetBrandDraft,
  onSetColorDraft,
  onSetTagDraft,
  onToggleSuggestedTag,
  onClearTags,
  onRemove,
  onSave,
}: Props) {
  const { colors, isDark } = useTheme();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        modalBackdrop: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.32)',
          justifyContent: 'flex-end',
        },
        sheet: {
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          backgroundColor: colors.bg,
          borderTopWidth: 1,
          borderTopColor: colors.borderLight,
          paddingHorizontal: s(3),
          paddingTop: s(2),
          paddingBottom: s(3),
          gap: s(2),
          maxHeight: '84%',
        },
        header: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        title: { ...font.h2, color: colors.text },
        closeBtn: {
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.6)',
        },
        scroll: {
          gap: s(1.5),
          paddingBottom: s(1),
        },
        previewCard: {
          flexDirection: 'row',
          gap: s(1.4),
          padding: s(1.2),
          borderRadius: 18,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
        },
        previewImage: {
          width: s(10),
          height: s(10),
          borderRadius: 14,
          backgroundColor: 'rgba(0,0,0,0.05)',
        },
        previewMeta: {
          flex: 1,
          justifyContent: 'center',
          gap: s(0.8),
        },
        previewTitle: {
          ...font.h3,
          color: colors.text,
        },
        previewSubtitle: {
          ...font.meta,
          color: colors.textDim,
          fontSize: 11,
        },
        statusChip: {
          alignSelf: 'flex-start',
          borderRadius: 999,
          borderWidth: 1,
          paddingHorizontal: s(1.2),
          paddingVertical: s(0.55),
        },
        statusChipReady: {
          backgroundColor: 'rgba(231,248,236,0.96)',
          borderColor: 'rgba(69,140,89,0.35)',
        },
        statusChipMissing: {
          backgroundColor: 'rgba(255,245,224,0.96)',
          borderColor: 'rgba(184,133,35,0.28)',
        },
        statusTxt: {
          ...font.meta,
          color: colors.text,
          fontSize: 10,
          fontWeight: '800',
        },
        fieldWrap: { gap: 6 },
        fieldLabel: { ...font.meta, color: colors.textDim, fontWeight: '700' },
        categoryRow: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: s(1),
        },
        categoryChip: {
          borderRadius: 999,
          borderWidth: 1,
          borderColor: colors.borderLight,
          paddingHorizontal: s(1.5),
          paddingVertical: s(0.8),
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.86)',
        },
        categoryChipActive: {
          backgroundColor: colors.text,
          borderColor: colors.text,
        },
        categoryChipTxt: {
          ...font.meta,
          color: colors.text,
          fontWeight: '700',
          fontSize: 12,
        },
        categoryChipTxtActive: {
          color: isDark ? colors.bg : '#fff',
        },
        twoCol: {
          flexDirection: 'row',
          gap: s(1.2),
        },
        fieldHalf: {
          flex: 1,
        },
        input: {
          minHeight: 42,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.8)',
          paddingHorizontal: s(2),
          paddingVertical: s(1.2),
          color: colors.text,
        },
        inputMultiline: {
          minHeight: s(8.2),
          textAlignVertical: 'top',
        },
        sectionHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: s(0.8),
        },
        sectionMeta: {
          ...font.meta,
          color: colors.textDim,
          fontSize: 11,
        },
        clearTxt: {
          ...font.meta,
          color: colors.text,
          fontSize: 11,
          fontWeight: '800',
        },
        tagGrid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: s(0.9),
        },
        tagChip: {
          borderRadius: 999,
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.88)',
          paddingHorizontal: s(1.3),
          paddingVertical: s(0.8),
        },
        tagChipActive: {
          backgroundColor: colors.text,
          borderColor: colors.text,
        },
        tagChipTxt: {
          ...font.meta,
          color: colors.text,
          fontSize: 11,
          fontWeight: '700',
        },
        tagChipTxtActive: {
          color: isDark ? colors.bg : '#fff',
        },
        tagPill: {
          borderRadius: 999,
          backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(20,20,20,0.08)',
          paddingHorizontal: s(1.2),
          paddingVertical: s(0.65),
        },
        tagPillTxt: {
          ...font.meta,
          color: colors.text,
          fontSize: 11,
          fontWeight: '700',
        },
        actionsRow: {
          flexDirection: 'row',
          gap: s(1.5),
          marginTop: s(1),
        },
        actionBtn: {
          flex: 1,
          minHeight: 42,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.84)',
        },
        actionPrimary: {
          backgroundColor: colors.text,
          borderColor: colors.text,
        },
        actionTxt: { ...font.meta, color: colors.text, fontWeight: '800' },
        actionPrimaryTxt: { ...font.meta, color: isDark ? colors.bg : '#fff', fontWeight: '800' },
        dangerBtn: {
          borderColor: 'rgba(181,62,41,0.24)',
          backgroundColor: 'rgba(255,238,234,0.9)',
        },
        dangerTxt: {
          ...font.meta,
          color: '#B53E29',
          fontWeight: '800',
        },
      }),
    [colors, isDark]
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.modalBackdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Edit closet item</Text>
            <Pressable style={styles.closeBtn} onPress={onClose} disabled={saving}>
              <Ionicons name="close" size={18} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
            {editingItem ? (
              <View style={styles.previewCard}>
                <ExpoImage source={{ uri: editingItem.uri }} style={styles.previewImage} contentFit="cover" />
                <View style={styles.previewMeta}>
                  <Text style={styles.previewTitle}>
                    {brandDraft.trim() || editingItem.brand || editingItem.category || 'Closet item'}
                  </Text>
                  <Text style={styles.previewSubtitle}>
                    {editingItem.color || 'No colour yet'} • {editingItem.embedding?.slot || 'No slot'}
                  </Text>
                  <View
                    style={[
                      styles.statusChip,
                      editingItem.embedding?.vector?.length ? styles.statusChipReady : styles.statusChipMissing,
                    ]}
                  >
                    <Text style={styles.statusTxt}>
                      {editingItem.embedding?.vector?.length ? 'Embedding available' : 'Embedding missing'}
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}

            <View style={styles.fieldWrap}>
              <Text style={styles.fieldLabel}>Category</Text>
              <View style={styles.categoryRow}>
                {categories.map((category) => {
                  const selected = categoryDraft === category;
                  return (
                    <Pressable
                      key={category}
                      onPress={() => onSetCategoryDraft(category)}
                      style={[styles.categoryChip, selected && styles.categoryChipActive]}
                    >
                      <Text style={[styles.categoryChipTxt, selected && styles.categoryChipTxtActive]}>
                        {category}
                      </Text>
                    </Pressable>
                  );
                })}
                <Pressable
                  onPress={() => onSetCategoryDraft('')}
                  style={[styles.categoryChip, !categoryDraft && styles.categoryChipActive]}
                >
                  <Text style={[styles.categoryChipTxt, !categoryDraft && styles.categoryChipTxtActive]}>
                    Clear
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.twoCol}>
              <View style={[styles.fieldWrap, styles.fieldHalf]}>
                <Text style={styles.fieldLabel}>Brand</Text>
                <TextInput
                  value={brandDraft}
                  onChangeText={onSetBrandDraft}
                  placeholder="Brand"
                  placeholderTextColor={colors.textDim}
                  autoCapitalize="words"
                  style={styles.input}
                />
              </View>
              <View style={[styles.fieldWrap, styles.fieldHalf]}>
                <Text style={styles.fieldLabel}>Colour</Text>
                <TextInput
                  value={colorDraft}
                  onChangeText={onSetColorDraft}
                  placeholder="Colour"
                  placeholderTextColor={colors.textDim}
                  autoCapitalize="words"
                  style={styles.input}
                />
              </View>
            </View>

            <View style={styles.fieldWrap}>
              <View style={styles.sectionHeader}>
                <Text style={styles.fieldLabel}>Suggested tags</Text>
                <Text style={styles.sectionMeta}>Tap to add or remove</Text>
              </View>
              <View style={styles.tagGrid}>
                {suggestedTags.map((tag) => {
                  const selected = draftTags.some((entry) => entry.toLowerCase() === tag.toLowerCase());
                  return (
                    <Pressable
                      key={tag}
                      onPress={() => onToggleSuggestedTag(tag)}
                      style={[styles.tagChip, selected && styles.tagChipActive]}
                    >
                      <Text style={[styles.tagChipTxt, selected && styles.tagChipTxtActive]}>{tag}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.fieldWrap}>
              <View style={styles.sectionHeader}>
                <Text style={styles.fieldLabel}>Tags</Text>
                <Pressable onPress={onClearTags}>
                  <Text style={styles.clearTxt}>Clear all</Text>
                </Pressable>
              </View>
              <TextInput
                value={tagDraft}
                onChangeText={onSetTagDraft}
                placeholder="vintage, denim, blue"
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                multiline
                style={[styles.input, styles.inputMultiline]}
              />
              <View style={styles.tagGrid}>
                {draftTags.map((tag) => (
                  <View key={tag} style={styles.tagPill}>
                    <Text style={styles.tagPillTxt}>{tag}</Text>
                  </View>
                ))}
              </View>
            </View>
          </ScrollView>

          <View style={styles.actionsRow}>
            <Pressable
              style={[styles.actionBtn, styles.dangerBtn]}
              onPress={() => editingItem && onRemove(editingItem)}
              disabled={saving || !editingItem}
            >
              <Text style={styles.dangerTxt}>Remove</Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={onClose} disabled={saving}>
              <Text style={styles.actionTxt}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.actionBtn, styles.actionPrimary, saving && { opacity: 0.72 }]}
              onPress={onSave}
              disabled={saving}
            >
              {saving ? <ActivityIndicator size="small" color={isDark ? colors.bg : '#fff'} /> : <Text style={styles.actionPrimaryTxt}>Save changes</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
