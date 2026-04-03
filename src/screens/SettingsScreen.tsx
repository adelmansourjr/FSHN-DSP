import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Glass from '../components/Glass';
import MinimalHeader from '../components/MinimalHeader';
import PrivacyPolicyScreen from './PrivacyPolicyScreen';
import { useTheme } from '../theme/ThemeContext';
import { colors as baseColors, font, hairline, s } from '../theme/tokens';
import { pressFeedback } from '../theme/pressFeedback';
import { useAuth } from '../context/AuthContext';
import BlockedUsersPanel from '../components/settings/BlockedUsersPanel';
import type { SexPreference } from '../lib/firebaseUsers';
import {
  emptyShippingAddress,
  sanitizeShippingAddress,
  shippingAddressesEqual,
} from '../lib/shippingAddress';
import {
  ensureHapticsPreferenceLoaded,
  selectionAsync,
  setHapticsEnabled,
} from '../lib/haptics';

export type SettingsScreenProps = {
  onClose?: () => void;
};

type SettingsPrefs = {
  notifications: {
    push: boolean;
    email: boolean;
    promo: boolean;
  };
  app?: {
    haptics?: boolean;
  };
};

type SettingsTheme = {
  bg: string;
  cardBg: string;
  cardBorder: string;
  text: string;
  textDim: string;
  chipBg: string;
  chipActiveBg: string;
  chipActiveText: string;
  inputBg: string;
  inputBorder: string;
  lockedBg: string;
  lockedBorder: string;
  toggleTrackOff: string;
  toggleTrackOn: string;
  toggleThumbOff: string;
  toggleThumbOn: string;
  success: string;
};

const PREFS_KEY = 'settings.preferences.v1';
const DOCK_BOTTOM_OFFSET = 28;
const DOCK_HEIGHT = 64;
const DOCK_CLEAR = DOCK_BOTTOM_OFFSET + DOCK_HEIGHT;
const SEX_OPTIONS: Array<{ label: string; value: SexPreference }> = [
  { label: 'Male', value: 'male' },
  { label: 'Female', value: 'female' },
  { label: 'All', value: 'all' },
];

export default function SettingsScreen({ onClose }: SettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;

  const { mode, setMode, colors, isDark } = useTheme();
  const { user, profile, signOut, updateProfile, updateAccountCredentials } = useAuth();

  const [pushNotif, setPushNotif] = useState(true);
  const [emailNotif, setEmailNotif] = useState(false);
  const [promoNotif, setPromoNotif] = useState(true);

  const [haptics, setHaptics] = useState(true);

  const [accountEmail, setAccountEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [sexPreference, setSexPreference] = useState<SexPreference>('all');
  const [shippingName, setShippingName] = useState('');
  const [shippingLine1, setShippingLine1] = useState('');
  const [shippingLine2, setShippingLine2] = useState('');
  const [shippingCity, setShippingCity] = useState('');
  const [shippingRegion, setShippingRegion] = useState('');
  const [shippingPostalCode, setShippingPostalCode] = useState('');
  const [shippingCountry, setShippingCountry] = useState('');
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountNotice, setAccountNotice] = useState<string | null>(null);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);

  const theme: SettingsTheme = {
    bg: colors.bg,
    cardBg: isDark ? 'rgba(17,17,20,0.85)' : 'rgba(255,255,255,0.85)',
    cardBorder: isDark ? 'rgba(255,255,255,0.08)' : colors.borderLight,
    text: colors.text,
    textDim: colors.textDim,
    chipBg: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)',
    chipActiveBg: colors.text,
    chipActiveText: colors.bg,
    inputBg: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.72)',
    inputBorder: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
    lockedBg: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(11,11,14,0.03)',
    lockedBorder: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(11,11,14,0.08)',
    toggleTrackOff: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)',
    toggleTrackOn: isDark ? 'rgba(255,255,255,0.82)' : colors.text,
    toggleThumbOff: isDark ? 'rgba(13,13,16,0.92)' : '#ffffff',
    toggleThumbOn: isDark ? colors.bg : '#ffffff',
    success: isDark ? '#8fd89b' : '#2e7d32',
  };

  const bottomPad = insets.bottom + DOCK_CLEAR + s(12);

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 260,
      useNativeDriver: true,
    }).start();
  }, [anim]);

  useEffect(() => {
    let mounted = true;
    const loadPrefs = async () => {
      try {
        const raw = await AsyncStorage.getItem(PREFS_KEY);
        if (raw && mounted) {
          const parsed = JSON.parse(raw) as SettingsPrefs;
          if (parsed?.notifications) {
            setPushNotif(!!parsed.notifications.push);
            setEmailNotif(!!parsed.notifications.email);
            setPromoNotif(!!parsed.notifications.promo);
          }
        }
        const storedHaptics = await ensureHapticsPreferenceLoaded();
        if (mounted) setHaptics(storedHaptics);
      } catch {
        // ignore storage failures
      }
    };
    void loadPrefs();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const prefs: SettingsPrefs = {
      notifications: {
        push: pushNotif,
        email: emailNotif,
        promo: promoNotif,
      },
    };
    void AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [pushNotif, emailNotif, promoNotif]);

  useEffect(() => {
    setAccountEmail(user?.email || '');
  }, [user?.email]);

  useEffect(() => {
    setSexPreference(profile?.sexPreference || 'all');
  }, [profile?.sexPreference]);

  useEffect(() => {
    const address = sanitizeShippingAddress(profile?.shippingAddress || emptyShippingAddress());
    setShippingName(address.name || profile?.displayName || '');
    setShippingLine1(address.line1);
    setShippingLine2(address.line2);
    setShippingCity(address.city);
    setShippingRegion(address.region);
    setShippingPostalCode(address.postalCode);
    setShippingCountry(address.country);
  }, [profile?.displayName, profile?.shippingAddress]);

  const storedEmail = user?.email?.trim() || '';
  const nextEmail = accountEmail.trim();
  const storedSexPreference = profile?.sexPreference || 'all';
  const storedShippingAddress = sanitizeShippingAddress(profile?.shippingAddress || emptyShippingAddress());
  const nextShippingAddress = sanitizeShippingAddress({
    name: shippingName || profile?.displayName || '',
    line1: shippingLine1,
    line2: shippingLine2,
    city: shippingCity,
    region: shippingRegion,
    postalCode: shippingPostalCode,
    country: shippingCountry,
  });
  const emailChanged = !!user && nextEmail !== storedEmail;
  const passwordChanged = newPassword.length > 0;
  const sexPreferenceChanged = sexPreference !== storedSexPreference;
  const shippingAddressChanged = !shippingAddressesEqual(storedShippingAddress, nextShippingAddress);
  const accountDirty = emailChanged || passwordChanged || sexPreferenceChanged || shippingAddressChanged;

  const close = () => {
    Animated.timing(anim, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start(() => onClose?.());
  };

  const handleSignOut = async () => {
    await signOut();
  };

  const handleHapticsToggle = (value: boolean) => {
    setHaptics(value);
    void setHapticsEnabled(value);
    if (value) {
      void selectionAsync();
    }
  };

  const handleSaveAccount = async () => {
    if (!user || !profile || accountSaving || !accountDirty) return;

    if (emailChanged && !nextEmail) {
      Alert.alert('Email required', 'Please enter a valid email address.');
      return;
    }

    if (passwordChanged && newPassword.length < 6) {
      Alert.alert('Weak password', 'Password must be at least 6 characters.');
      return;
    }

    const requiresCredentialUpdate = emailChanged || passwordChanged;
    if (requiresCredentialUpdate && !currentPassword) {
      Alert.alert(
        'Current password required',
        'Enter your current password before changing your email or password.'
      );
      return;
    }

    const hasAnyShippingInput = Object.values(nextShippingAddress).some(Boolean);
    const hasRequiredShippingFields =
      !!nextShippingAddress.name &&
      !!nextShippingAddress.line1 &&
      !!nextShippingAddress.city &&
      !!nextShippingAddress.postalCode &&
      !!nextShippingAddress.country;
    if (hasAnyShippingInput && !hasRequiredShippingFields) {
      Alert.alert(
        'Delivery address incomplete',
        'Add recipient name, address line 1, city, postal code, and country before saving.'
      );
      return;
    }

    setAccountSaving(true);
    setAccountNotice(null);

    let emailSaved = false;
    let passwordSaved = false;
    let preferenceSaved = false;

    try {
      if (requiresCredentialUpdate) {
        const result = await updateAccountCredentials({
          email: emailChanged ? nextEmail : undefined,
          currentPassword,
          newPassword: passwordChanged ? newPassword : undefined,
        });
        emailSaved = result.emailChanged;
        passwordSaved = result.passwordChanged;
      }

      if (sexPreferenceChanged || shippingAddressChanged) {
        await updateProfile({
          displayName: profile.displayName,
          bio: profile.bio,
          sexPreference,
          shippingAddress: nextShippingAddress,
        });
        preferenceSaved = sexPreferenceChanged || shippingAddressChanged;
      }

      setCurrentPassword('');
      setNewPassword('');

      const messages: string[] = [];
      if (emailSaved) messages.push('Email updated.');
      if (passwordSaved) messages.push('Password updated.');
      if (sexPreferenceChanged && preferenceSaved) messages.push('Gender preference updated.');
      if (shippingAddressChanged && preferenceSaved) messages.push('Delivery address updated.');
      setAccountNotice(messages.join(' '));
    } catch (error: any) {
      const credentialPartial = (error?.partial || {}) as {
        emailChanged?: boolean;
        passwordChanged?: boolean;
      };
      emailSaved = emailSaved || !!credentialPartial.emailChanged;
      passwordSaved = passwordSaved || !!credentialPartial.passwordChanged;

      const partialMessages: string[] = [];
      if (emailSaved) partialMessages.push('Email updated.');
      if (passwordSaved) partialMessages.push('Password updated.');
      if (sexPreferenceChanged && preferenceSaved) partialMessages.push('Gender preference updated.');
      if (shippingAddressChanged && preferenceSaved) partialMessages.push('Delivery address updated.');

      if (emailSaved || passwordSaved) {
        setCurrentPassword('');
        setNewPassword('');
      }

      if (partialMessages.length) {
        setAccountNotice(partialMessages.join(' '));
      }

      const detail = formatAccountError(error);
      Alert.alert(
        partialMessages.length ? 'Partially saved' : 'Update failed',
        partialMessages.length ? `${partialMessages.join(' ')} ${detail}` : detail
      );
    } finally {
      setAccountSaving(false);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <Animated.View
        style={{
          flex: 1,
          opacity: anim,
          transform: [
            {
              translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
            },
          ],
        }}
      >
        <MinimalHeader
          title="Settings"
          onRightPress={close}
          rightIcon="close"
          rightA11yLabel="Close settings"
        />

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        >
          <Glass
            style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
            tint={isDark ? 'dark' : 'light'}
            intensity={isDark ? 32 : 22}
          >
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Account</Text>
            <Text style={[styles.sectionHint, { color: theme.textDim }]}>
              Change your login details here. Your current password is required before Firebase will
              allow email or password updates.
            </Text>

            <AccountField
              label="Email"
              value={accountEmail}
              onChangeText={(value) => {
                setAccountNotice(null);
                setAccountEmail(value);
              }}
              placeholder="you@email.com"
              keyboardType="email-address"
              theme={theme}
            />

            <AccountField
              label="Current password"
              value={currentPassword}
              onChangeText={(value) => {
                setAccountNotice(null);
                setCurrentPassword(value);
              }}
              placeholder="Required for email/password changes"
              secureTextEntry
              theme={theme}
            />

            <AccountField
              label="New password"
              value={newPassword}
              onChangeText={(value) => {
                setAccountNotice(null);
                setNewPassword(value);
              }}
              placeholder="Leave blank to keep current password"
              secureTextEntry
              helper="Passwords must be at least 6 characters."
              theme={theme}
            />

            <View style={[styles.lockedRow, { backgroundColor: theme.lockedBg, borderColor: theme.lockedBorder }]}>
              <View style={styles.lockedHeader}>
                <Text style={[styles.fieldLabel, { color: theme.text }]}>Date of birth</Text>
                <View style={[styles.lockedBadge, { backgroundColor: theme.chipBg, borderColor: theme.cardBorder }]}>
                  <Ionicons name="lock-closed-outline" size={12} color={theme.textDim} />
                  <Text style={[styles.lockedBadgeText, { color: theme.textDim }]}>Locked</Text>
                </View>
              </View>
              <Text style={[styles.lockedValue, { color: theme.text }]}>
                {profile?.dateOfBirth || 'Not available'}
              </Text>
              <Text style={[styles.fieldHint, { color: theme.textDim }]}>
                Locked after signup for age verification.
              </Text>
            </View>

            <View style={styles.prefGroup}>
              <Text style={[styles.fieldLabel, { color: theme.text }]}>Gender preference</Text>
              <View style={styles.prefChipWrap}>
                {SEX_OPTIONS.map((option) => {
                  const selected = sexPreference === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => {
                        setAccountNotice(null);
                        setSexPreference(option.value);
                      }}
                      style={({ pressed }) => [
                        styles.prefChip,
                        {
                          backgroundColor: selected ? theme.chipActiveBg : theme.chipBg,
                          borderColor: selected ? theme.chipActiveBg : theme.cardBorder,
                        },
                        pressFeedback(pressed, selected ? 'strong' : 'subtle'),
                      ]}
                    >
                      <Text
                        style={[
                          styles.prefChipText,
                          { color: selected ? theme.chipActiveText : theme.text },
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[styles.fieldHint, { color: theme.textDim }]}>
                Used to tune recommendations and try-on matching.
              </Text>
            </View>

            <View style={styles.addressGroup}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Delivery address</Text>
              <Text style={[styles.sectionHint, { color: theme.textDim }]}>
                Saved here and attached to future marketplace orders.
              </Text>

              <AccountField
                label="Recipient name"
                value={shippingName}
                onChangeText={(value) => {
                  setAccountNotice(null);
                  setShippingName(value);
                }}
                placeholder="Full name"
                theme={theme}
              />

              <AccountField
                label="Address line 1"
                value={shippingLine1}
                onChangeText={(value) => {
                  setAccountNotice(null);
                  setShippingLine1(value);
                }}
                placeholder="Street address"
                theme={theme}
              />

              <AccountField
                label="Address line 2"
                value={shippingLine2}
                onChangeText={(value) => {
                  setAccountNotice(null);
                  setShippingLine2(value);
                }}
                placeholder="Apartment, suite, building"
                theme={theme}
              />

              <View style={styles.inlineFields}>
                <View style={styles.inlineField}>
                  <AccountField
                    label="City"
                    value={shippingCity}
                    onChangeText={(value) => {
                      setAccountNotice(null);
                      setShippingCity(value);
                    }}
                    placeholder="City"
                    theme={theme}
                  />
                </View>
                <View style={styles.inlineField}>
                  <AccountField
                    label="State / region"
                    value={shippingRegion}
                    onChangeText={(value) => {
                      setAccountNotice(null);
                      setShippingRegion(value);
                    }}
                    placeholder="State"
                    theme={theme}
                  />
                </View>
              </View>

              <View style={styles.inlineFields}>
                <View style={styles.inlineField}>
                  <AccountField
                    label="Postal code"
                    value={shippingPostalCode}
                    onChangeText={(value) => {
                      setAccountNotice(null);
                      setShippingPostalCode(value);
                    }}
                    placeholder="Postal code"
                    theme={theme}
                  />
                </View>
                <View style={styles.inlineField}>
                  <AccountField
                    label="Country"
                    value={shippingCountry}
                    onChangeText={(value) => {
                      setAccountNotice(null);
                      setShippingCountry(value);
                    }}
                    placeholder="Country"
                    theme={theme}
                  />
                </View>
              </View>
            </View>

            {accountNotice ? (
              <Text style={[styles.accountNotice, { color: theme.success }]}>{accountNotice}</Text>
            ) : null}

            <Pressable
              style={({ pressed }) => [
                styles.saveBtn,
                { backgroundColor: theme.text },
                (!accountDirty || accountSaving || !user || !profile) && styles.saveBtnDisabled,
                accountDirty && !accountSaving && !!user && !!profile
                  ? pressFeedback(pressed, 'strong')
                  : null,
              ]}
              accessibilityRole="button"
              onPress={handleSaveAccount}
              disabled={!accountDirty || accountSaving || !user || !profile}
            >
              {accountSaving ? (
                <ActivityIndicator size="small" color={theme.bg} />
              ) : (
                <Ionicons name="save-outline" size={16} color={theme.bg} />
              )}
              <Text style={[styles.saveBtnText, { color: theme.bg }]}>Save account & address</Text>
            </Pressable>
          </Glass>

          <Glass
            style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
            tint={isDark ? 'dark' : 'light'}
            intensity={isDark ? 32 : 22}
          >
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Notifications</Text>
            <ToggleRow label="Push notifications" value={pushNotif} onChange={setPushNotif} theme={theme} />
            <ToggleRow label="Email updates" value={emailNotif} onChange={setEmailNotif} theme={theme} />
            <ToggleRow label="Promotions & drops" value={promoNotif} onChange={setPromoNotif} theme={theme} />
          </Glass>

          <Glass
            style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
            tint={isDark ? 'dark' : 'light'}
            intensity={isDark ? 32 : 22}
          >
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Appearance</Text>
            <ToggleRow
              label="Dark mode"
              value={mode === 'dark'}
              onChange={(value) => setMode(value ? 'dark' : 'light')}
              theme={theme}
            />
            <Text style={[styles.sectionHint, { color: theme.textDim }]}>Applies across the app.</Text>
          </Glass>

          <Glass
            style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
            tint={isDark ? 'dark' : 'light'}
            intensity={isDark ? 32 : 22}
          >
            <Text style={[styles.sectionTitle, { color: theme.text }]}>App settings</Text>
            <ToggleRow label="Haptics" value={haptics} onChange={handleHapticsToggle} theme={theme} />
            <Text style={[styles.sectionHint, { color: theme.textDim }]}>
              Controls supported tap and sheet feedback across the app.
            </Text>
          </Glass>

          <Glass
            style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
            tint={isDark ? 'dark' : 'light'}
            intensity={isDark ? 32 : 22}
          >
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Safety</Text>
            <BlockedUsersPanel viewerUid={user?.uid} />
          </Glass>

          <Glass
            style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.cardBorder }]}
            tint={isDark ? 'dark' : 'light'}
            intensity={isDark ? 32 : 22}
          >
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Legal</Text>
            <Text style={[styles.sectionHint, { color: theme.textDim }]}>
              Read the short privacy policy and the basic terms used during signup.
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.legalRow,
                {
                  backgroundColor: theme.inputBg,
                  borderColor: theme.inputBorder,
                },
                pressFeedback(pressed, 'subtle'),
              ]}
              accessibilityRole="button"
              onPress={() => setShowPrivacyPolicy(true)}
            >
              <View style={styles.legalCopy}>
                <Text style={[styles.legalTitle, { color: theme.text }]}>Privacy policy</Text>
                <Text style={[styles.legalHint, { color: theme.textDim }]}>
                  See what data is collected, where it is stored, and how it is used.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.textDim} />
            </Pressable>
          </Glass>

          <Pressable
            style={({ pressed }) => [
              styles.signOutBtn,
              { borderColor: theme.cardBorder, backgroundColor: theme.chipBg },
              pressFeedback(pressed, 'strong'),
            ]}
            accessibilityRole="button"
            onPress={handleSignOut}
          >
            <Ionicons name="log-out-outline" size={16} color={theme.text} />
            <Text style={[styles.signOutText, { color: theme.text }]}>Sign out</Text>
          </Pressable>
        </ScrollView>

        {showPrivacyPolicy && (
          <View style={[styles.overlaySheet, { backgroundColor: theme.bg }]}>
            <PrivacyPolicyScreen
              onClose={() => setShowPrivacyPolicy(false)}
              dockAware
            />
          </View>
        )}
      </Animated.View>
    </View>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
  theme,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  theme: SettingsTheme;
}) {
  return (
    <View style={[styles.toggleRow, { borderBottomColor: theme.cardBorder }]}>
      <Text style={[styles.toggleLabel, { color: theme.text }]}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: theme.toggleTrackOff, true: theme.toggleTrackOn }}
        thumbColor={value ? theme.toggleThumbOn : theme.toggleThumbOff}
        ios_backgroundColor={theme.toggleTrackOff}
      />
    </View>
  );
}

function AccountField({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  helper,
  theme,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address';
  helper?: string;
  theme: SettingsTheme;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={[styles.fieldLabel, { color: theme.text }]}>{label}</Text>
      <View style={[styles.inputWrap, { backgroundColor: theme.inputBg, borderColor: theme.inputBorder }]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.textDim}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: theme.text }]}
        />
      </View>
      {helper ? <Text style={[styles.fieldHint, { color: theme.textDim }]}>{helper}</Text> : null}
    </View>
  );
}

function formatAccountError(error: any) {
  const code = String(error?.code || error?.message || '');
  if (code.includes('auth/invalid-email')) return 'Enter a valid email address.';
  if (code.includes('auth/email-already-in-use')) return 'That email address is already in use.';
  if (code.includes('auth/weak-password')) return 'Password must be at least 6 characters.';
  if (code.includes('auth/wrong-password') || code.includes('auth/invalid-credential')) {
    return 'Your current password is incorrect.';
  }
  if (code.includes('auth/requires-recent-login')) {
    return 'Please sign in again, then retry this update.';
  }
  if (code.includes('auth/no-email-provider')) {
    return 'This account cannot update email or password from the current auth provider.';
  }
  if (code.includes('auth/missing-password')) {
    return 'Enter your current password before saving email or password changes.';
  }
  if (code.includes('permission-denied')) {
    return 'That field is locked by your current database rules.';
  }
  return 'Something went wrong while saving your account details.';
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: baseColors.bg,
  },
  content: {
    paddingHorizontal: s(3),
    paddingTop: s(2),
    gap: s(3),
  },
  card: {
    padding: s(4),
    gap: s(2),
  },
  sectionTitle: {
    ...font.h3,
    fontWeight: '800',
    marginBottom: s(0.5),
  },
  sectionHint: {
    ...font.meta,
    color: baseColors.textDim,
    marginBottom: s(1),
    lineHeight: 18,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: s(1.5),
    borderBottomWidth: hairline,
  },
  toggleLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: baseColors.text,
  },
  fieldGroup: {
    gap: s(1),
  },
  fieldLabel: {
    ...font.meta,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
    color: baseColors.text,
  },
  inputWrap: {
    borderWidth: hairline,
    borderRadius: 16,
    paddingHorizontal: s(2),
  },
  input: {
    minHeight: s(11),
    fontSize: 14,
    fontWeight: '600',
    color: baseColors.text,
  },
  fieldHint: {
    ...font.meta,
    color: baseColors.textDim,
    lineHeight: 18,
  },
  lockedRow: {
    borderWidth: hairline,
    borderRadius: 18,
    padding: s(3),
    gap: s(1),
  },
  lockedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: s(2),
  },
  lockedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(1),
    borderWidth: hairline,
    borderRadius: 999,
    paddingHorizontal: s(1.5),
    paddingVertical: s(0.75),
  },
  lockedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  lockedValue: {
    fontSize: 15,
    fontWeight: '700',
    color: baseColors.text,
  },
  prefGroup: {
    gap: s(1.25),
  },
  addressGroup: {
    gap: s(1.25),
    marginTop: s(1),
  },
  inlineFields: {
    flexDirection: 'row',
    gap: s(1.5),
  },
  inlineField: {
    flex: 1,
  },
  prefChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: s(1.5),
  },
  prefChip: {
    paddingHorizontal: s(2.5),
    paddingVertical: s(1.5),
    borderRadius: 999,
    borderWidth: hairline,
  },
  prefChipText: {
    fontSize: 13,
    fontWeight: '700',
  },
  accountNotice: {
    ...font.meta,
    fontWeight: '700',
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s(1.5),
    borderRadius: 999,
    paddingVertical: s(2),
    marginTop: s(0.5),
  },
  saveBtnDisabled: {
    opacity: 0.45,
  },
  saveBtnText: {
    fontWeight: '800',
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(2),
    borderWidth: hairline,
    borderRadius: 18,
    paddingHorizontal: s(3),
    paddingVertical: s(2.4),
  },
  legalCopy: {
    flex: 1,
    gap: s(0.5),
  },
  legalTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  legalHint: {
    ...font.meta,
    lineHeight: 18,
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s(1.5),
    borderWidth: hairline,
    borderColor: baseColors.borderLight,
    borderRadius: 999,
    paddingVertical: s(2),
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  signOutText: {
    fontWeight: '700',
    color: baseColors.text,
  },
  overlaySheet: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
  },
});
