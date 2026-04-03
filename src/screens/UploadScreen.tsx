import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Text,
  Alert,
  Linking,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Dimensions,
  Switch,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import MinimalHeader from '../components/MinimalHeader';
import { font, s, hairline } from '../theme/tokens';
import { pressFeedback } from '../theme/pressFeedback';
import Field from '../components/upload/Field';
import SelectModal from '../components/upload/SelectModal';
import Pill from '../components/upload/Pill';
import CachedImage from '../components/ui/CachedImage';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useNav } from '../navigation/NavContext';
import { createListing, updateListing } from '../lib/firebaseListings';
import { classifyUploadPhoto } from '../components/classifier/clientClassifier';
import { CLASSIFIER_ENDPOINT } from '../config/classifier';
import { classifyPhoto, type ClassifyResult } from '../utils/localClassifier';
import {
  cloneListingEditorState,
  createEmptyListingEditorState,
  hasMeaningfulListingContent,
  listingEditorStatesEqual,
  normalizeListingColor,
  parseListingColors,
  serializeListingColors,
  type ListingEditorPhoto,
  type ListingEditorState,
  type UploadEditorMode,
  type UploadEditorRequest,
} from '../lib/listingEditor';
import {
  formatParcelProfileLabel,
  PARCEL_PROFILE_OPTIONS,
} from '../lib/shippingCo';
import { COLOUR_OPTIONS } from '../data/catalog';
import {
  deleteLocalListingDraft,
  saveLocalListingDraft,
} from '../lib/localListingDrafts';
import { registerUploadLeaveGuard } from '../lib/uploadLeaveGuard';

const CATEGORIES = ['Top', 'Bottom', 'Dress', 'Shoes', 'Outerwear', 'Accessory'];
const CONDITIONS = ['New with tags', 'New (no tags)', 'Like new', 'Good', 'Fair'];
const GENDER_OPTIONS = ['Male', 'Female', 'Unisex'] as const;
const PARCEL_PROFILE_LABEL_OPTIONS = PARCEL_PROFILE_OPTIONS.map((value) => formatParcelProfileLabel(value));
const COLOR_OPTIONS = [...COLOUR_OPTIONS].map((color) =>
  color.replace(/\b\w/g, (m) => m.toUpperCase())
);
const SIZE_SETS: Record<string, string[]> = {
  Top: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'],
  Bottom: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'],
  Dress: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'],
  Shoes: ['5', '6', '7', '8', '9', '10', '11', '12'],
  Outerwear: ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'],
  Accessory: ['OS'],
};

const DOCK_BOTTOM_OFFSET = 28;
const DOCK_HEIGHT = 64;
const DOCK_CLEAR = DOCK_BOTTOM_OFFSET + DOCK_HEIGHT;

const formatPriceInput = (input: string) => {
  const sanitized = input.replace(/[^0-9.]/g, '');
  const [whole = '', decimals] = sanitized.split('.');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedWhole = trimmedWhole || (whole ? '0' : '');
  if (decimals === undefined) {
    return normalizedWhole;
  }
  const decimalPart = decimals.replace(/\./g, '').slice(0, 2);
  return `${normalizedWhole || '0'}${decimalPart ? `.${decimalPart}` : '.'}`;
};

type GenderValue = 'men' | 'women' | 'unisex';

const GENDER_LABELS: Record<GenderValue, (typeof GENDER_OPTIONS)[number]> = {
  men: 'Male',
  women: 'Female',
  unisex: 'Unisex',
};

const normalizeGenderValue = (value?: string | null): GenderValue | null => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (
    /\bunisex\b/.test(raw) ||
    /\bgender[\s-]?neutral\b/.test(raw) ||
    /\ball genders?\b/.test(raw)
  ) {
    return 'unisex';
  }
  if (
    /\bfemale\b/.test(raw) ||
    /\bwomen'?s?\b/.test(raw) ||
    /\bwoman\b/.test(raw) ||
    /\blad(?:y|ies)\b/.test(raw) ||
    /\bgirls?\b/.test(raw) ||
    /\bwomenswear\b/.test(raw)
  ) {
    return 'women';
  }
  if (
    /\bmale\b/.test(raw) ||
    /\bmen'?s?\b/.test(raw) ||
    /\bman\b/.test(raw) ||
    /\bboys?\b/.test(raw) ||
    /\bmenswear\b/.test(raw)
  ) {
    return 'men';
  }
  return null;
};

const inferGenderFromTags = (tags: string[]): GenderValue | null => {
  let male = 0;
  let female = 0;
  let unisex = 0;
  tags.forEach((tag) => {
    const normalized = normalizeGenderValue(tag);
    if (normalized === 'men') male += 1;
    else if (normalized === 'women') female += 1;
    else if (normalized === 'unisex') unisex += 1;
  });
  if (unisex > 0) return 'unisex';
  if (male > 0 && female > 0) return 'unisex';
  if (male > 0) return 'men';
  if (female > 0) return 'women';
  return null;
};

const inferGenderFromClassifier = (
  remote: ClassifyResult | null,
  local: ReturnType<typeof classifyUploadPhoto> | null,
) : GenderValue | null => {
  const directCandidates = [
    normalizeGenderValue((remote as any)?.gender),
    normalizeGenderValue((remote as any)?.sex),
    normalizeGenderValue((remote as any)?.targetGender),
    normalizeGenderValue((remote as any)?.raw?.gender),
    normalizeGenderValue((remote as any)?.raw?.sex),
    normalizeGenderValue((remote as any)?.raw?.targetGender),
    normalizeGenderValue((local as any)?.gender),
    normalizeGenderValue((local as any)?.sex),
  ].filter(Boolean) as GenderValue[];
  if (directCandidates.length) return directCandidates[0];

  const tags = [
    ...(Array.isArray(remote?.tags) ? remote!.tags : []),
    ...(Array.isArray(local?.tags) ? local!.tags : []),
  ].map((tag) => String(tag || '').trim()).filter(Boolean);

  return inferGenderFromTags(tags);
};

const normalizeTag = (value: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  return trimmed;
};

const dedupeTags = (values: string[]) => {
  const next: string[] = [];
  const seen = new Set<string>();
  values.forEach((value) => {
    const normalized = normalizeTag(value);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    next.push(normalized);
  });
  return next;
};

const removeGenderTags = (tags: string[]) => {
  return dedupeTags(tags).filter((tag) => !normalizeGenderValue(tag));
};

const formatGenderLabel = (value?: string | null) => {
  const normalized = normalizeGenderValue(value);
  if (!normalized) return '';
  return GENDER_LABELS[normalized];
};

const toDisplayColor = (value: string) =>
  String(value || '')
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());

const parseClassifierColors = (...sources: unknown[]) => {
  const tokens: string[] = [];
  sources.forEach((source) => {
    if (Array.isArray(source)) {
      source.forEach((entry) => tokens.push(String(entry || '')));
      return;
    }
    const raw = String(source || '').trim();
    if (!raw) return;
    raw
      .split(/[,/]|(?:\s+and\s+)/i)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => tokens.push(entry));
  });
  const normalized = tokens
    .map((entry) => normalizeListingColor(entry))
    .filter(Boolean) as string[];
  return parseListingColors(normalized);
};

/* ───────────────────── permissions ───────────────────── */
async function confirm(title: string, message: string) {
  return new Promise<boolean>((resolve) => {
    Alert.alert(title, message, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Allow access', onPress: () => resolve(true) },
    ]);
  });
}

function useCleanPermissions() {
  const openSettings = useCallback(() => {
    try { Linking.openSettings(); } catch {}
  }, []);

  const ensurePhotos = useCallback(async () => {
    const info = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (info.granted) return true;
    if (info.canAskAgain) {
      const ok = await confirm('Allow Photos', 'FSHN needs photo access to add your item images.');
      if (!ok) return false;
      const req = await ImagePicker.requestMediaLibraryPermissionsAsync({ accessPrivileges: 'all' } as any);
      if (req.granted) return true;
    }
    Alert.alert('Photos access off', 'Please enable Photos for FSHN in Settings.', [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open Settings', onPress: openSettings },
    ]);
    return false;
  }, [openSettings]);

  const ensureCamera = useCallback(async () => {
    const info = await ImagePicker.getCameraPermissionsAsync();
    if (info.granted) return true;
    if (info.canAskAgain) {
      const ok = await confirm('Allow Camera', 'FSHN needs your camera to photograph items.');
      if (!ok) return false;
      const req = await ImagePicker.requestCameraPermissionsAsync();
      if (req.granted) return true;
    }
    Alert.alert('Camera access off', 'Please enable Camera in Settings.', [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open Settings', onPress: openSettings },
    ]);
    return false;
  }, [openSettings]);

  return { ensurePhotos, ensureCamera };
}

/* ───────────────────────── screen ───────────────────────── */
type UploadScreenProps = {
  editorRequest?: UploadEditorRequest | null;
};

const nextAutoFillKey = (listing: ListingEditorState, includeDetails: boolean) => {
  const uri = listing.photos[0]?.uri;
  if (!uri) return null;
  return `${uri}:${includeDetails ? 'full' : 'tags'}`;
};

export default function UploadScreen({ editorRequest = null }: UploadScreenProps) {
  const insets = useSafeAreaInsets();
  const { ensurePhotos, ensureCamera } = useCleanPermissions();
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const nav = useNav();
  const lastAutoFillKey = useRef<string | null>(null);
  const lastEditorRequestId = useRef<string | null>(null);

  const [editorMode, setEditorMode] = useState<UploadEditorMode>({ kind: 'create' });
  const [listing, setListing] = useState<ListingEditorState>(() => createEmptyListingEditorState());
  const [baselineListing, setBaselineListing] = useState<ListingEditorState>(() => createEmptyListingEditorState());

  const [pickerOpen, setPickerOpen] = useState<null | 'category' | 'parcelProfile' | 'gender' | 'size' | 'condition' | 'colors'>(null);
  const [publishing, setPublishing] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [autoFillEnabled, setAutoFillEnabled] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  const sizeOptions = useMemo(
    () => SIZE_SETS[listing.category || 'Top'] || SIZE_SETS.Top,
    [listing.category]
  );

  const addPhoto = useCallback((newPhotos: ListingEditorPhoto[]) => {
    setListing((p) => ({ ...p, photos: [...p.photos, ...newPhotos].slice(0, 24) }));
  }, []);

  const pickFromLibrary = useCallback(async () => {
    if (!(await ensurePhotos())) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      quality: 0.9,
      selectionLimit: 10,
    } as any);
    if (res.canceled) return;
    const next = res.assets?.map((a) => ({ uri: a.uri })) || [];
    addPhoto(next);
  }, [ensurePhotos, addPhoto]);

  const openCamera = useCallback(async () => {
    if (!(await ensureCamera())) return;
    const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    if (res.canceled) return;
    const asset = res.assets?.[0];
    if (asset?.uri) addPhoto([{ uri: asset.uri }]);
  }, [ensureCamera, addPhoto]);

  const removePhoto = useCallback((uri: string) => {
    setListing((p) => ({ ...p, photos: p.photos.filter((ph) => ph.uri !== uri) }));
  }, []);

  const addTag = useCallback((t: string) => {
    const val = t.trim();
    if (!val) return;
    setListing((p) => {
      const mergedTags = dedupeTags([...p.tags, val]);
      const inferredGender = normalizeGenderValue(val) || p.gender || inferGenderFromTags(mergedTags);
      return {
        ...p,
        gender: inferredGender,
        tags: removeGenderTags(mergedTags).slice(0, 40),
      };
    });
  }, []);
  const removeTag = useCallback((t: string) => {
    setListing((p) => ({
      ...p,
      tags: removeGenderTags(p.tags.filter((x) => x !== t)).slice(0, 40),
    }));
  }, []);

  const toggleColor = useCallback((value: string) => {
    const normalized = normalizeListingColor(value);
    if (!normalized) return;
    setListing((p) => {
      const existing = parseListingColors(p.color);
      const next = existing.includes(normalized)
        ? existing.filter((entry) => entry !== normalized)
        : [...existing, normalized];
      return {
        ...p,
        color: serializeListingColors(next),
      };
    });
  }, []);

  const removeColor = useCallback((value: string) => {
    const normalized = normalizeListingColor(value);
    if (!normalized) return;
    setListing((p) => ({
      ...p,
      color: serializeListingColors(parseListingColors(p.color).filter((entry) => entry !== normalized)),
    }));
  }, []);

  const handlePriceChange = useCallback((price: string) => {
    setListing((p) => ({ ...p, price: formatPriceInput(price) }));
  }, []);

  const isEditingListing = editorMode.kind === 'listing';
  const isEditingDraft = editorMode.kind === 'draft';
  const busy = publishing || savingDraft;

  const canPublish = useMemo(() => {
    const hasPhoto = listing.photos.length > 0;
    const hasTitle = listing.title.trim().length >= 3;
    const hasTags = listing.tags.length > 0;
    const priceNum = Number(listing.price);
    return hasPhoto && hasTitle && hasTags && priceNum > 0 && !!listing.parcelProfile && !busy;
  }, [busy, listing.parcelProfile, listing.photos.length, listing.title, listing.tags.length, listing.price]);

  const canSaveDraft = useMemo(() => {
    if (isEditingListing) return false;
    if (busy) return false;
    return hasMeaningfulListingContent(listing);
  }, [busy, isEditingListing, listing]);
  const isDirty = useMemo(
    () => !listingEditorStatesEqual(listing, baselineListing),
    [baselineListing, listing]
  );

  const applyAutoFill = useCallback(
    async (uri: string, includeDetails: boolean) => {
      setAutoFilling(true);
      try {
        let remoteResult: ClassifyResult | null = null;
        let localResult: ReturnType<typeof classifyUploadPhoto> | null = null;
        if (CLASSIFIER_ENDPOINT) {
          try {
            remoteResult = await classifyPhoto(uri);
          } catch (err) {
            console.warn('[classifier] remote autofill failed', err);
          }
        }
        if (!remoteResult) {
          localResult = classifyUploadPhoto(uri);
        }
        const result = remoteResult || localResult;
        if (!result) {
          Alert.alert(
            'Auto-fill unavailable',
            'We could not classify this photo yet. Try a different photo or fill fields manually.',
          );
          return;
        }

        setListing((prev) => {
          const mergedTags = dedupeTags([...prev.tags, ...(result.tags || [])]).slice(0, 40);
          const inferredGender =
            inferGenderFromClassifier(remoteResult, localResult) || inferGenderFromTags(mergedTags);
          const classifiedColors = parseClassifierColors(
            (remoteResult as any)?.color,
            (remoteResult as any)?.colors,
            remoteResult?.tags,
            localResult?.color,
            (localResult as any)?.colors,
            localResult?.tags,
          );
          if (!includeDetails) {
            return {
              ...prev,
              tags: removeGenderTags(mergedTags).slice(0, 40),
            };
          }
          const nextCategory = result.category || prev.category;
          const nextSize = nextCategory !== prev.category ? null : prev.size;
          const nextGender = inferredGender || prev.gender;
          return {
            ...prev,
            category: nextCategory,
            gender: nextGender,
            size: nextSize,
            brand: result.brand ?? prev.brand,
            color: classifiedColors.length
              ? serializeListingColors([...parseListingColors(prev.color), ...classifiedColors])
              : prev.color,
            tags: removeGenderTags(mergedTags).slice(0, 40),
          };
        });
      } finally {
        setAutoFilling(false);
      }
    },
    [setListing],
  );

  const resetComposer = useCallback(
    (force = false) => {
      if (!force && isDirty) {
        Alert.alert('Discard current changes?', 'This will clear the current listing editor.', [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Start fresh',
            style: 'destructive',
            onPress: () => {
              setEditorMode({ kind: 'create' });
              const empty = createEmptyListingEditorState();
              setListing(empty);
              setBaselineListing(empty);
              setTagDraft('');
              setPickerOpen(null);
              lastAutoFillKey.current = null;
            },
          },
        ]);
        return;
      }
      setEditorMode({ kind: 'create' });
      const empty = createEmptyListingEditorState();
      setListing(empty);
      setBaselineListing(empty);
      setTagDraft('');
      setPickerOpen(null);
      lastAutoFillKey.current = null;
    },
    [isDirty],
  );

  const saveDraft = useCallback(async () => {
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to save a listing draft on this device.');
      return false;
    }
    if (isEditingListing) return false;
    if (!hasMeaningfulListingContent(listing)) {
      Alert.alert('Nothing to save', 'Add at least a photo or some listing details before saving a draft.');
      return false;
    }

    try {
      setSavingDraft(true);
      const saved = await saveLocalListingDraft(
        user.uid,
        listing,
        editorMode.kind === 'draft' ? editorMode.draftId : null
      );
      const nextListing = cloneListingEditorState(saved.listing);
      setListing(nextListing);
      setBaselineListing(nextListing);
      setEditorMode({ kind: 'draft', draftId: saved.id });
      setTagDraft('');
      setPickerOpen(null);
      lastAutoFillKey.current = nextAutoFillKey(nextListing, autoFillEnabled);
      Alert.alert('Draft saved', 'This listing draft is saved locally on your device.');
      return true;
    } catch {
      Alert.alert('Draft save failed', 'Please try again in a moment.');
      return false;
    } finally {
      setSavingDraft(false);
    }
  }, [autoFillEnabled, editorMode.kind, isEditingListing, listing, user]);

  const publish = useCallback(async () => {
    if (!canPublish) return false;
    if (!user) {
      Alert.alert('Sign in required', 'Please sign in to publish a listing.');
      return false;
    }
    try {
      setPublishing(true);
      const priceNum = Number(listing.price);
      const colorList = parseListingColors(listing.color);
      if (editorMode.kind === 'listing') {
        const updated = await updateListing({
          listingId: editorMode.listingId,
          title: listing.title,
          description: listing.description,
          price: priceNum,
          brand: listing.brand,
          category: listing.category || undefined,
          parcelProfile: listing.parcelProfile || undefined,
          size: listing.size || undefined,
          condition: listing.condition || undefined,
          gender: listing.gender || undefined,
          colors: colorList,
          tags: listing.tags,
          photos: listing.photos,
        });
        const nextListing = {
          ...listing,
          photos: updated.photos.map((photo) => ({
            uri: photo.url,
            storagePath: photo.path || null,
          })),
        };
        setListing(nextListing);
        setBaselineListing(nextListing);
        lastAutoFillKey.current = nextAutoFillKey(nextListing, autoFillEnabled);
        Alert.alert('Listing updated', 'Your published listing has been updated.');
        return true;
      }

      await createListing({
        sellerUid: user.uid,
        title: listing.title,
        description: listing.description,
        price: priceNum,
        brand: listing.brand,
        category: listing.category || undefined,
        parcelProfile: listing.parcelProfile || undefined,
        size: listing.size || undefined,
        condition: listing.condition || undefined,
        gender: listing.gender || undefined,
        colors: colorList,
        tags: listing.tags,
        photos: listing.photos,
      });

      if (editorMode.kind === 'draft') {
        try {
          await deleteLocalListingDraft(user.uid, editorMode.draftId);
        } catch {
          // no-op
        }
      }

      Alert.alert('Listing created', 'Your item has been published successfully.');
      const empty = createEmptyListingEditorState();
      setEditorMode({ kind: 'create' });
      setListing(empty);
      setBaselineListing(empty);
      setTagDraft('');
      setPickerOpen(null);
      lastAutoFillKey.current = null;
      return true;
    } catch (err) {
      Alert.alert(
        editorMode.kind === 'listing' ? 'Update failed' : 'Upload failed',
        'Please try again in a moment.'
      );
      return false;
    } finally {
      setPublishing(false);
    }
  }, [autoFillEnabled, canPublish, editorMode, listing, user]);

  const confirmLeaveEditor = useCallback(async () => {
    if (!isDirty) return true;
    if (busy) {
      Alert.alert(
        'Please wait',
        publishing ? 'Your listing is still being published.' : 'Your draft is still being saved.',
      );
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const buttons: Array<{ text: string; style?: 'cancel' | 'default' | 'destructive'; onPress: () => void }> = [
        {
          text: 'Stay',
          style: 'cancel',
          onPress: () => resolve(false),
        },
      ];

      if (!isEditingListing && canSaveDraft) {
        buttons.unshift({
          text: isEditingDraft ? 'Update draft' : 'Save draft',
          onPress: () => {
            void (async () => {
              resolve(await saveDraft());
            })();
          },
        });
      }

      if (canPublish) {
        buttons.unshift({
          text: isEditingListing ? 'Update listing' : 'Publish',
          onPress: () => {
            void (async () => {
              resolve(await publish());
            })();
          },
        });
      }

      buttons.push({
        text: 'Leave',
        style: 'destructive',
        onPress: () => resolve(true),
      });

      Alert.alert(
        'Leave upload?',
        isEditingListing
          ? 'Stay here to keep editing, update this listing now, or leave without saving additional changes.'
          : 'Stay here to keep editing, save this work as a draft, publish it now, or leave without saving.',
        buttons,
      );
    });
  }, [
    busy,
    canPublish,
    canSaveDraft,
    isEditingDraft,
    isEditingListing,
    isDirty,
    publish,
    publishing,
    saveDraft,
  ]);

  const SCROLL_BOTTOM_PAD = DOCK_CLEAR + s(18);

  const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

  useEffect(() => {
    if (!editorRequest?.requestId) return;
    if (lastEditorRequestId.current === editorRequest.requestId) return;
    lastEditorRequestId.current = editorRequest.requestId;
    const nextListing = cloneListingEditorState(editorRequest.form);
    setPublishing(false);
    setSavingDraft(false);
    setEditorMode(editorRequest.mode);
    setListing(nextListing);
    setBaselineListing(nextListing);
    setTagDraft('');
    setPickerOpen(null);
    setAutoFillEnabled(false);
    lastAutoFillKey.current = nextAutoFillKey(nextListing, false);
  }, [editorRequest]);

  useEffect(() => {
    const uri = listing.photos[0]?.uri;
    if (!uri || autoFilling) return;
    const mode = autoFillEnabled ? 'full' : 'tags';
    const key = `${uri}:${mode}`;
    if (key === lastAutoFillKey.current) return;
    lastAutoFillKey.current = key;
    applyAutoFill(uri, autoFillEnabled);
  }, [autoFillEnabled, listing.photos, autoFilling, applyAutoFill]);

  useEffect(() => registerUploadLeaveGuard(confirmLeaveEditor), [confirmLeaveEditor]);

  const screenTitle = isEditingListing ? 'Edit listing' : isEditingDraft ? 'Draft listing' : 'Upload';
  const contextTitle = isEditingListing
    ? 'Live listing'
    : isEditingDraft
      ? 'Local draft'
      : 'New listing';
  const contextBody = isEditingListing
    ? 'Update the listing here. Your changes go live when you tap Update listing.'
    : isEditingDraft
      ? 'Saved only on this device until you publish it.'
      : 'Save a draft on this device if you want to finish this listing later.';
  const contextBadgeLabel = isEditingListing ? 'Live' : isEditingDraft ? 'Draft' : 'New';
  const primaryActionLabel = isEditingListing
    ? (publishing ? 'Updating...' : 'Update listing')
    : (publishing ? 'Publishing...' : 'Publish');
  const draftActionLabel = savingDraft
    ? 'Saving...'
    : isEditingDraft
      ? 'Update draft'
      : 'Save draft';

  const leaveUpload = useCallback(() => {
    void nav.leaveUpload?.();
  }, [nav]);

  return (
    <View style={styles.root}>
      <MinimalHeader
        title={screenTitle}
        leftIcon="close"
        onLeftPress={leaveUpload}
        leftA11yLabel="Leave upload"
        rightSecondaryIcon={editorMode.kind !== 'create' ? 'add' : undefined}
        rightSecondaryLabel={editorMode.kind !== 'create' ? 'New' : undefined}
        onSecondaryPress={editorMode.kind !== 'create' ? () => resetComposer() : undefined}
        rightSecondaryA11yLabel={editorMode.kind !== 'create' ? 'Start a new listing' : undefined}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={s(8)}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: SCROLL_BOTTOM_PAD }}
        >
          <BlurView intensity={24} tint={isDark ? 'dark' : 'light'} style={styles.contextCard}>
            <View style={styles.contextRow}>
              <View style={styles.contextCopy}>
                <Text style={styles.contextEyebrow}>{contextTitle}</Text>
                <Text style={styles.contextBody}>{contextBody}</Text>
              </View>
              <View style={styles.contextBadge}>
                <Text style={styles.contextBadgeTxt}>{contextBadgeLabel}</Text>
              </View>
            </View>
          </BlurView>

          {/* Photos Section */}
          <BlurView intensity={24} tint={isDark ? 'dark' : 'light'} style={styles.section}>
            <Text style={styles.sectionTitle}>Photos</Text>
            <Text style={styles.sectionSubtitle}>
              First photo becomes your cover and is used for try-on.
            </Text>

            {/* Empty state */}
            {listing.photos.length === 0 ? (
              <Pressable
                onPress={pickFromLibrary}
                style={({ pressed }) => [styles.photoEmpty, pressFeedback(pressed)]}
              >
                <Text style={styles.photoEmptyIcon}>＋</Text>
                <Text style={styles.photoEmptyText}>Add Photos</Text>
              </Pressable>
            ) : (
              <View style={styles.photoGrid}>
                {listing.photos.map((p, i) => (
                  <Pressable
                    key={p.uri}
                    onPress={() =>
                      Alert.alert('Remove photo', 'Do you want to delete this photo?', [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => removePhoto(p.uri) },
                      ])
                    }
                    style={({ pressed }) => [styles.photoTile, pressFeedback(pressed, 'subtle')]}
                  >
                    <CachedImage
                      source={{ uri: p.uri }}
                      style={styles.photoImg}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                      transition={120}
                      borderRadius={0}
                    />
                    {/* ❌ small badge */}
                    <View style={styles.removeBadge}>
                      <Text style={styles.removeBadgeTxt}>✕</Text>
                    </View>
                    {i === 0 && (
                      <View style={styles.coverBadge}>
                        <Text style={styles.coverBadgeTxt}>Cover</Text>
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
            )}

            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'center',
                gap: s(3),
                marginTop: s(3),
              }}
            >
              <Pill label="Add more" icon="image-outline" onPress={pickFromLibrary} emphasis />
              <Pill label="Camera" icon="camera-outline" onPress={openCamera} />
            </View>

            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleLabel}>Auto-fill details</Text>
                <Text style={styles.toggleHint}>
                  Uses the cover photo to suggest tags, category, gender, brand, and color.
                </Text>
                {autoFilling && <Text style={styles.toggleHint}>Auto-filling…</Text>}
              </View>
              <Switch
                value={autoFillEnabled}
                onValueChange={(value) => {
                  if (value && listing.photos.length === 0) {
                    Alert.alert('Add a photo first', 'Choose at least one photo to auto-fill details.');
                    return;
                  }
                  if (value) lastAutoFillKey.current = null;
                  setAutoFillEnabled(value);
                }}
                trackColor={{ false: 'rgba(0,0,0,0.1)', true: colors.text }}
                thumbColor={autoFillEnabled ? '#fff' : '#f4f4f4'}
              />
            </View>
          </BlurView>

          {/* Details block */}
          <BlurView intensity={24} tint={isDark ? 'dark' : 'light'} style={styles.section}>
            <Text style={styles.sectionTitle}>Details</Text>
            <Field
              label="Title"
              placeholder="e.g. Linen boxy blazer"
              value={listing.title}
              onChangeText={(title) => setListing((p) => ({ ...p, title }))}
            />
            <Field
              label="Description"
              placeholder="Describe fit, fabric, and any flaws..."
              multiline
              numberOfLines={5}
              value={listing.description}
              onChangeText={(description) => setListing((p) => ({ ...p, description }))}
            />
            <View style={styles.priceBlock}>
              <Field
                label="Price"
                placeholder="£75.00"
                value={listing.price}
                onChangeText={handlePriceChange}
                keyboardType="decimal-pad"
                returnKeyType="done"
              />
              <Text style={styles.helperText}>Buyers see this amount before shipping and fees.</Text>
            </View>
            <View style={styles.priceBlock}>
              <Field
                label="Parcel size"
                placeholder="Select parcel size"
                value={formatParcelProfileLabel(listing.parcelProfile)}
                readOnly
                onPress={() => setPickerOpen('parcelProfile')}
              />
              <Text style={styles.helperText}>Used to quote ShippingCo shipping at checkout.</Text>
            </View>
            <Field
              label="Category"
              placeholder="Select category"
              value={listing.category || ''}
              readOnly
              onPress={() => setPickerOpen('category')}
            />
            <Field
              label="Gender"
              placeholder="Select gender"
              value={formatGenderLabel(listing.gender)}
              readOnly
              onPress={() => setPickerOpen('gender')}
            />
            <Field
              label="Size"
              placeholder="Select size"
              value={listing.size || ''}
              readOnly
              onPress={() => setPickerOpen('size')}
            />
            <Field
              label="Condition"
              placeholder="Select condition"
              value={listing.condition || ''}
              readOnly
              onPress={() => setPickerOpen('condition')}
            />
            <Field
              label="Brand"
              placeholder="Optional"
              value={listing.brand}
              onChangeText={(brand) => setListing((p) => ({ ...p, brand }))}
            />
            <Field
              label="Colors"
              placeholder="Select colors"
              value={parseListingColors(listing.color).map(toDisplayColor).join(', ')}
              readOnly
              onPress={() => setPickerOpen('colors')}
            />
            <View style={styles.tagsBlock}>
              <View style={styles.tagActions}>
                <Pill
                  label="Add color"
                  icon="color-palette-outline"
                  emphasis
                  onPress={() => setPickerOpen('colors')}
                />
                <Text style={styles.tagHint}>Choose from the recommender color list only.</Text>
              </View>
              {parseListingColors(listing.color).length > 0 && (
                <View style={styles.tagPills}>
                  {parseListingColors(listing.color).map((color) => (
                    <Pill key={color} label={toDisplayColor(color)} onRemove={() => removeColor(color)} />
                  ))}
                </View>
              )}
            </View>

            <View style={styles.tagsBlock}>
              <Field
                label="Tags"
                placeholder="Add a tag"
                value={tagDraft}
                onChangeText={setTagDraft}
                onSubmitEditing={() => {
                  addTag(tagDraft);
                  setTagDraft('');
                }}
                returnKeyType="done"
              />
              <View style={styles.tagActions}>
                <Pill
                  label="Add tag"
                  icon="pricetag-outline"
                  emphasis
                  onPress={() => {
                    addTag(tagDraft);
                    setTagDraft('');
                  }}
                />
                <Text style={styles.tagHint}>At least one tag is required.</Text>
              </View>
              {listing.tags.length > 0 && (
                <View style={styles.tagPills}>
                  {listing.tags.map((tag) => (
                    <Pill key={tag} label={tag} onRemove={() => removeTag(tag)} />
                  ))}
                </View>
              )}
              <Text style={styles.tagHint}>
                The more tags you add, the more accurately your item can be recommended.
              </Text>
            </View>
          </BlurView>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Floating Actions */}
      <View style={[styles.footer, { bottom: DOCK_CLEAR + s(2) }]}>
        <View style={styles.footerRow}>
          {!isEditingListing && (
            <Pressable
              onPress={saveDraft}
              disabled={!canSaveDraft}
              style={({ pressed }) => [
                styles.secondaryBtn,
                !canSaveDraft && { opacity: 0.45 },
                canSaveDraft ? pressFeedback(pressed, 'subtle') : null,
              ]}
            >
              <Text style={styles.secondaryBtnTxt}>{draftActionLabel}</Text>
            </Pressable>
          )}

          <Pressable
            onPress={publish}
            disabled={!canPublish}
            style={({ pressed }) => [
              styles.primaryBtn,
              !canPublish && { opacity: 0.4 },
              canPublish ? pressFeedback(pressed, 'strong') : null,
              isEditingListing && styles.primaryBtnFull,
            ]}
          >
            <Text style={styles.primaryBtnTxt}>{primaryActionLabel}</Text>
          </Pressable>
        </View>
      </View>

      {/* Pickers */}
      <SelectModal
        visible={pickerOpen === 'parcelProfile'}
        title="Parcel size"
        type="chips"
        options={PARCEL_PROFILE_LABEL_OPTIONS}
        value={formatParcelProfileLabel(listing.parcelProfile) || null}
        onClose={() => setPickerOpen(null)}
        onSelect={(v) => {
          const nextProfile =
            PARCEL_PROFILE_OPTIONS.find((entry) => formatParcelProfileLabel(entry) === v) || null;
          setListing((p) => ({ ...p, parcelProfile: nextProfile }));
          setPickerOpen(null);
        }}
      />
      <SelectModal
        visible={pickerOpen === 'category'}
        title="Category"
        type="grid"
        options={CATEGORIES}
        value={listing.category}
        onClose={() => setPickerOpen(null)}
        onSelect={(v) => {
          setListing((p) => ({ ...p, category: v, size: null }));
          setPickerOpen(null);
        }}
      />
      <SelectModal
        visible={pickerOpen === 'gender'}
        title="Gender"
        type="chips"
        options={[...GENDER_OPTIONS]}
        value={formatGenderLabel(listing.gender) || null}
        onClose={() => setPickerOpen(null)}
        onSelect={(v) => {
          const selected = normalizeGenderValue(v);
          setListing((p) => ({
            ...p,
            gender: selected,
            tags: removeGenderTags(p.tags).slice(0, 40),
          }));
          setPickerOpen(null);
        }}
      />
      <SelectModal
        visible={pickerOpen === 'size'}
        title="Size"
        type="chips"
        options={sizeOptions}
        value={listing.size}
        onClose={() => setPickerOpen(null)}
        onSelect={(v) => {
          setListing((p) => ({ ...p, size: v }));
          setPickerOpen(null);
        }}
      />
      <SelectModal
        visible={pickerOpen === 'colors'}
        title="Colors"
        type="chips"
        options={COLOR_OPTIONS}
        value={null}
        values={parseListingColors(listing.color).map(toDisplayColor)}
        multiple
        onToggle={(v) => toggleColor(v)}
        onClose={() => setPickerOpen(null)}
        onSelect={() => {}}
      />
      <SelectModal
        visible={pickerOpen === 'condition'}
        title="Condition"
        type="list"
        options={CONDITIONS}
        value={listing.condition}
        onClose={() => setPickerOpen(null)}
        onSelect={(v) => {
          setListing((p) => ({ ...p, condition: v }));
          setPickerOpen(null);
        }}
      />
    </View>
  );
}

/* ───────────── styles ───────────── */
const makeStyles = (colors: any, isDark: boolean) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  contextCard: {
    marginHorizontal: s(3),
    marginTop: s(4),
    paddingHorizontal: s(3),
    paddingVertical: s(2.4),
    borderRadius: s(6),
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(17,17,20,0.82)' : 'rgba(255,255,255,0.58)',
    overflow: 'hidden',
  },
  contextRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: s(2),
    flexWrap: 'wrap',
  },
  contextCopy: {
    flex: 1,
    minWidth: 0,
  },
  contextEyebrow: {
    ...font.meta,
    color: colors.text,
    fontWeight: '900',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  contextBody: {
    ...font.meta,
    color: colors.textDim,
    lineHeight: 18,
    flexShrink: 1,
  },
  contextBadge: {
    alignSelf: 'flex-start',
    flexShrink: 0,
    borderRadius: 999,
    paddingHorizontal: s(1.8),
    paddingVertical: s(0.8),
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.92)',
  },
  contextBadgeTxt: {
    ...font.meta,
    color: colors.text,
    fontWeight: '900',
    fontSize: 11,
  },
  section: {
    marginHorizontal: s(3),
    marginTop: s(4),
    padding: s(3),
    borderRadius: s(6),
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(17,17,20,0.85)' : 'rgba(255,255,255,0.55)',
    overflow: 'hidden',
  },
  sectionTitle: { ...font.h2, color: colors.text, marginBottom: s(1.5) },
  sectionSubtitle: { ...font.meta, color: colors.textDim, marginBottom: s(3) },
  helperText: {
    ...font.meta,
    color: colors.textDim,
    marginTop: s(1),
    marginLeft: s(1),
  },
  toggleRow: {
    marginTop: s(3),
    paddingTop: s(2),
    borderTopWidth: hairline,
    borderTopColor: colors.borderLight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(2),
  },
  toggleLabel: { ...font.meta, color: colors.text, fontWeight: '800' },
  toggleHint: { ...font.meta, color: colors.textDim, marginTop: 2 },
  priceBlock: {
    marginTop: s(2),
  },
  tagsBlock: {
    marginTop: s(2),
    gap: s(2),
  },
  tagActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(2),
  },
  tagHint: {
    ...font.meta,
    color: colors.textDim,
  },
  tagPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: s(1.5),
  },
  photoEmpty: {
    height: 160,
    borderRadius: s(10),
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  photoEmptyIcon: { fontSize: 40, color: colors.text, opacity: 0.6 },
  photoEmptyText: { marginTop: 6, fontSize: 14, fontWeight: '600', color: colors.textDim },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: s(2) },
  photoTile: {
    width: (Dimensions.get('window').width - s(12)) / 3 - s(1.5),
    aspectRatio: 1,
    borderRadius: s(5),
    overflow: 'hidden',
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.6)',
  },
  photoImg: { width: '100%', height: '100%' },
  removeBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBadgeTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  coverBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  coverBadgeTxt: { color: '#fff', fontSize: 10, fontWeight: '700' },
  footer: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  footerRow: {
    width: '100%',
    paddingHorizontal: s(3),
    flexDirection: 'row',
    gap: s(1.5),
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: colors.text,
    borderRadius: 999,
    paddingHorizontal: s(5),
    paddingVertical: s(3.5),
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnFull: {
    maxWidth: 320,
  },
  secondaryBtn: {
    flex: 1,
    borderRadius: 999,
    paddingHorizontal: s(4),
    paddingVertical: s(3.5),
    borderWidth: hairline,
    borderColor: colors.borderLight,
    backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.86)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnTxt: { color: isDark ? colors.bg : '#fff', fontWeight: '900', letterSpacing: 0.3, fontSize: 16 },
  secondaryBtnTxt: { color: colors.text, fontWeight: '800', letterSpacing: 0.2, fontSize: 15 },
});
