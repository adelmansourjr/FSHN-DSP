import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
  Animated,
  useWindowDimensions,
  LayoutAnimation,
  UIManager,
  Easing,
  Keyboard,
  Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Glass from '../components/Glass';
import { useTheme } from '../theme/ThemeContext';
import { font, hairline, s } from '../theme/tokens';
import { pressFeedback } from '../theme/pressFeedback';
import { useAuth } from '../context/AuthContext';
import { isAdultFromDob, isDobString, normalizeUsername } from '../lib/firebaseUsers';
import { selectionAsync } from '../lib/haptics';
import {
  PRIVACY_POLICY_LAST_UPDATED,
  PRIVACY_POLICY_VERSION,
} from '../lib/privacyPolicy';
import {
  sanitizeShippingAddress,
  type ShippingAddress,
} from '../lib/shippingAddress';

type AuthScreenProps = {
  onOpenPrivacyPolicy?: () => void;
};

type Mode = 'login' | 'signup';
type SexPreference = 'male' | 'female' | 'all';

const USERNAME_RE = /^[a-zA-Z0-9._]{3,20}$/;
const SEX_OPTIONS: Array<{ label: string; value: SexPreference }> = [
  { label: 'Male', value: 'male' },
  { label: 'Female', value: 'female' },
  { label: 'All', value: 'all' },
];
const DOB_WHEEL_ITEM_HEIGHT = 42;
const DOB_WHEEL_VISIBLE_ROWS = 5;
const DOB_WHEEL_SIDE_PADDING = DOB_WHEEL_ITEM_HEIGHT * Math.floor(DOB_WHEEL_VISIBLE_ROWS / 2);
const DOB_MONTHS = [
  { value: 1, label: 'Jan' },
  { value: 2, label: 'Feb' },
  { value: 3, label: 'Mar' },
  { value: 4, label: 'Apr' },
  { value: 5, label: 'May' },
  { value: 6, label: 'Jun' },
  { value: 7, label: 'Jul' },
  { value: 8, label: 'Aug' },
  { value: 9, label: 'Sep' },
  { value: 10, label: 'Oct' },
  { value: 11, label: 'Nov' },
  { value: 12, label: 'Dec' },
] as const;

type AuthFieldProps = {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: any;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  textDim: string;
  fieldLabelStyle: any;
  inputWrapStyle: any;
  inputStyle: any;
  spacing: number;
  onFocus?: () => void;
};

type WheelOption = {
  value: number;
  label: string;
};

type WheelColumnProps = {
  label: string;
  options: WheelOption[];
  selectedValue: number;
  onValueChange: (value: number) => void;
  colors: {
    text: string;
    textDim: string;
    borderLight: string;
  };
  isDark: boolean;
};

const AuthField = React.memo(({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize = 'none',
  textDim,
  fieldLabelStyle,
  inputWrapStyle,
  inputStyle,
  spacing,
  onFocus,
}: AuthFieldProps) => (
  <View style={{ marginTop: spacing }}>
    <Text style={fieldLabelStyle}>{label}</Text>
    <View style={inputWrapStyle}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={textDim}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        style={inputStyle}
        onFocus={onFocus}
      />
    </View>
  </View>
));

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const padDobPart = (value: number) => String(value).padStart(2, '0');

const formatDobParts = (year: number, month: number, day: number) =>
  `${year}-${padDobPart(month)}-${padDobPart(day)}`;

const getDaysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

const createDefaultDobParts = () => {
  const today = new Date();
  const eighteenYearsAgo = new Date(
    today.getFullYear() - 18,
    today.getMonth(),
    today.getDate()
  );
  return {
    year: eighteenYearsAgo.getFullYear(),
    month: eighteenYearsAgo.getMonth() + 1,
    day: eighteenYearsAgo.getDate(),
  };
};

const parseDobParts = (value: string) => {
  if (!isDobString(value)) return null;
  const [rawYear, rawMonth, rawDay] = value.split('-').map((part) => Number(part));
  if (!rawYear || !rawMonth || !rawDay) return null;
  if (rawMonth < 1 || rawMonth > 12) return null;
  const maxDay = getDaysInMonth(rawYear, rawMonth);
  if (rawDay < 1 || rawDay > maxDay) return null;
  return { year: rawYear, month: rawMonth, day: rawDay };
};

const WheelColumn = React.memo(
  ({ label, options, selectedValue, onValueChange, colors, isDark }: WheelColumnProps) => {
    const scrollRef = useRef<ScrollView | null>(null);
    const lastFeedbackValueRef = useRef(selectedValue);
    const isUserScrollingRef = useRef(false);
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.value === selectedValue)
    );

    useEffect(() => {
      lastFeedbackValueRef.current = selectedValue;
      if (isUserScrollingRef.current) return;
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          y: selectedIndex * DOB_WHEEL_ITEM_HEIGHT,
          animated: false,
        });
      });
    }, [selectedIndex, selectedValue]);

    const selectIndex = (
      index: number,
      {
        animated,
        triggerHaptic,
        align,
      }: { animated: boolean; triggerHaptic: boolean; align: boolean }
    ) => {
      const safeIndex = clamp(index, 0, options.length - 1);
      const option = options[safeIndex];
      if (!option) return;
      if (triggerHaptic && lastFeedbackValueRef.current !== option.value) {
        lastFeedbackValueRef.current = option.value;
        void selectionAsync();
      } else {
        lastFeedbackValueRef.current = option.value;
      }
      if (selectedValue !== option.value) {
        onValueChange(option.value);
      }
      if (align) {
        scrollRef.current?.scrollTo({
          y: safeIndex * DOB_WHEEL_ITEM_HEIGHT,
          animated,
        });
      }
    };

    return (
      <View style={{ flex: 1, gap: s(1) }}>
        <Text
          style={{
            ...font.meta,
            color: colors.textDim,
            fontWeight: '800',
            textAlign: 'center',
          }}
        >
          {label}
        </Text>
        <View
          style={{
            height: DOB_WHEEL_ITEM_HEIGHT * DOB_WHEEL_VISIBLE_ROWS,
            borderRadius: 18,
            overflow: 'hidden',
            borderWidth: hairline,
            borderColor: colors.borderLight,
            backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.92)',
          }}
        >
          <ScrollView
            ref={scrollRef}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={DOB_WHEEL_ITEM_HEIGHT}
            scrollEventThrottle={16}
            contentContainerStyle={{ paddingVertical: DOB_WHEEL_SIDE_PADDING }}
            onScrollBeginDrag={() => {
              isUserScrollingRef.current = true;
            }}
            onMomentumScrollBegin={() => {
              isUserScrollingRef.current = true;
            }}
            onScroll={(event) => {
              const nextIndex = Math.round(
                event.nativeEvent.contentOffset.y / DOB_WHEEL_ITEM_HEIGHT
              );
              selectIndex(nextIndex, { animated: false, triggerHaptic: true, align: false });
            }}
            onMomentumScrollEnd={(event) => {
              const nextIndex = Math.round(
                event.nativeEvent.contentOffset.y / DOB_WHEEL_ITEM_HEIGHT
              );
              isUserScrollingRef.current = false;
              selectIndex(nextIndex, { animated: false, triggerHaptic: false, align: true });
            }}
            onScrollEndDrag={(event) => {
              const nextIndex = Math.round(
                event.nativeEvent.contentOffset.y / DOB_WHEEL_ITEM_HEIGHT
              );
              const velocityY = Math.abs(event.nativeEvent.velocity?.y || 0);
              if (velocityY < 0.05) {
                isUserScrollingRef.current = false;
                selectIndex(nextIndex, { animated: true, triggerHaptic: false, align: true });
              }
            }}
          >
            {options.map((option, index) => {
              const active = option.value === selectedValue;
              return (
                <Pressable
                  key={`${label}-${option.value}`}
                  onPress={() =>
                    selectIndex(index, { animated: true, triggerHaptic: true, align: true })
                  }
                  style={{
                    height: DOB_WHEEL_ITEM_HEIGHT,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingHorizontal: s(1.5),
                  }}
                >
                  <Text
                    style={{
                      color: active ? colors.text : colors.textDim,
                      fontSize: active ? 17 : 15,
                      fontWeight: active ? '900' : '700',
                    }}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 8,
              right: 8,
              top:
                DOB_WHEEL_ITEM_HEIGHT * Math.floor(DOB_WHEEL_VISIBLE_ROWS / 2) - hairline / 2,
              height: DOB_WHEEL_ITEM_HEIGHT,
              borderRadius: 14,
              borderWidth: hairline,
              borderColor: colors.borderLight,
              backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.56)',
            }}
          />
        </View>
      </View>
    );
  }
);

export default function AuthScreen({ onOpenPrivacyPolicy }: AuthScreenProps) {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { signIn, signUp } = useAuth();

  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [bio, setBio] = useState('');
  const [sexPreference, setSexPreference] = useState<SexPreference>('all');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [signupStep, setSignupStep] = useState<1 | 2>(1);
  const [dobPickerOpen, setDobPickerOpen] = useState(false);
  const defaultDobParts = useMemo(() => createDefaultDobParts(), []);
  const [dobYear, setDobYear] = useState(defaultDobParts.year);
  const [dobMonth, setDobMonth] = useState(defaultDobParts.month);
  const [dobDay, setDobDay] = useState(defaultDobParts.day);
  const [shippingName, setShippingName] = useState('');
  const [shippingLine1, setShippingLine1] = useState('');
  const [shippingLine2, setShippingLine2] = useState('');
  const [shippingCity, setShippingCity] = useState('');
  const [shippingRegion, setShippingRegion] = useState('');
  const [shippingPostalCode, setShippingPostalCode] = useState('');
  const [shippingCountry, setShippingCountry] = useState('');
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const enterAnim = useRef(new Animated.Value(0)).current;
  const modeAnim = useRef(new Animated.Value(0)).current;
  const keyboardAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (Platform.OS === 'android') {
      UIManager.setLayoutAnimationEnabledExperimental?.(true);
    }
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, () => {
      Animated.timing(keyboardAnim, {
        toValue: 1,
        duration: Platform.OS === 'ios' ? 650 : 560,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      Animated.timing(keyboardAnim, {
        toValue: 0,
        duration: Platform.OS === 'ios' ? 600 : 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardAnim]);

  useEffect(() => {
    Animated.timing(enterAnim, {
      toValue: 1,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enterAnim]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setError(null);
    setSignupStep(1);
    setDobPickerOpen(false);
    Animated.timing(modeAnim, {
      toValue: 1,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      setMode(next);
      Animated.timing(modeAnim, {
        toValue: 0,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.bg },
        gradient: { ...StyleSheet.absoluteFillObject },
        content: {
          flexGrow: 1,
          paddingHorizontal: s(5),
          paddingTop: s(6) + insets.top,
          paddingBottom: insets.bottom + s(6),
          minHeight: windowHeight - insets.top - insets.bottom,
        },
        headerWrap: {
          alignItems: 'center',
          paddingTop: s(2),
          paddingBottom: s(3.5),
        },
        cardWrap: {
          flex: 1,
          justifyContent: 'center',
          marginTop: -s(30),
        },
        cardWrapLogin: {
          marginTop: -s(34),
        },
        cardWrapSignup: {
          marginTop: s(6),
        },
        header: {
          alignItems: 'center',
          gap: s(1.5),
        },
        logo: {
          width: s(17),
          height: s(17),
          borderRadius: s(5),
          overflow: 'hidden',
          shadowColor: '#000',
          shadowOpacity: isDark ? 0.28 : 0.1,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 8 },
        },
        brand: { ...font.h1, fontSize: 34, letterSpacing: 6, textTransform: 'uppercase' },
        tagline: { ...font.p, color: colors.textDim, textAlign: 'center', marginTop: s(1) },
        card: {
          padding: s(4),
          borderRadius: 28,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(12,12,14,0.7)' : 'rgba(255,255,255,0.92)',
          shadowColor: '#000',
          shadowOpacity: isDark ? 0.25 : 0.12,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
          elevation: 8,
          width: '100%',
          maxWidth: 420,
          alignSelf: 'center',
        },
        cardTitle: {
          ...font.h2,
          fontSize: 20,
          fontWeight: '900',
          color: colors.text,
          marginBottom: s(2),
        },
        cardHint: {
          ...font.meta,
          color: colors.textDim,
          marginBottom: s(1.5),
        },
        fieldLabel: { ...font.meta, color: colors.textDim, marginBottom: s(1) },
        inputWrap: {
          borderRadius: 14,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
          paddingHorizontal: s(3),
          paddingVertical: Platform.OS === 'ios' ? s(2.5) : s(2),
        },
        input: { color: colors.text, fontSize: 15, fontWeight: '600' },
        helper: { color: colors.textDim, marginTop: s(1.5), fontSize: 12 },
        primaryBtn: {
          marginTop: s(4),
          backgroundColor: colors.text,
          borderRadius: 14,
          paddingVertical: s(3),
          alignItems: 'center',
        },
        primaryText: { color: '#fff', fontWeight: '900', letterSpacing: 0.4 },
        secondaryBtn: {
          marginTop: s(2.5),
          borderRadius: 14,
          borderWidth: hairline,
          borderColor: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.12)',
          paddingVertical: s(2.5),
          alignItems: 'center',
          backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.95)',
          shadowColor: '#000',
          shadowOpacity: isDark ? 0.18 : 0.08,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 6 },
          elevation: 4,
        },
        secondaryText: { color: isDark ? colors.text : '#111', fontWeight: '900', letterSpacing: 0.2 },
        error: { color: colors.danger, marginTop: s(2), fontWeight: '700' },
        photoRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2.5),
          marginTop: s(2),
        },
        photoShell: {
          width: s(12),
          height: s(12),
          borderRadius: s(6),
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#fff',
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
        },
        photoImage: {
          width: '100%',
          height: '100%',
        },
        photoPlaceholder: {
          color: colors.textDim,
        },
        link: { color: colors.muted, fontWeight: '800' },
        footerRow: { marginTop: s(2.5), alignItems: 'center' },
        footerLink: {
          color: colors.muted,
          fontWeight: '900',
          textDecorationLine: 'underline',
          textDecorationColor: colors.muted,
        },
        prefRow: {
          marginTop: s(2.5),
        },
        prefChipWrap: {
          flexDirection: 'row',
          gap: s(1.5),
          marginTop: s(1),
        },
        prefChip: {
          flex: 1,
          borderRadius: 999,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
          paddingVertical: s(1.8),
          alignItems: 'center',
          justifyContent: 'center',
        },
        prefChipActive: {
          backgroundColor: colors.text,
          borderColor: 'transparent',
        },
        prefChipText: {
          color: colors.text,
          fontSize: 13,
          fontWeight: '800',
          letterSpacing: 0.2,
        },
        prefChipTextActive: {
          color: '#fff',
        },
        stepRow: {
          flexDirection: 'row',
          gap: s(1.2),
          marginTop: s(1.2),
          marginBottom: s(1.6),
        },
        stepChip: {
          flex: 1,
          borderRadius: 999,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.84)',
          paddingVertical: s(1.4),
          paddingHorizontal: s(1.6),
          alignItems: 'center',
          justifyContent: 'center',
        },
        stepChipActive: {
          backgroundColor: colors.text,
          borderColor: colors.text,
        },
        stepChipText: {
          ...font.meta,
          color: colors.text,
          fontWeight: '800',
          fontSize: 11,
          letterSpacing: 0.3,
        },
        stepChipTextActive: {
          color: '#fff',
        },
        stepChipTextDim: {
          color: colors.textDim,
        },
        dateFieldBtn: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        dateFieldValue: {
          color: colors.text,
          fontSize: 15,
          fontWeight: '700',
        },
        dateFieldPlaceholder: {
          color: colors.textDim,
          fontWeight: '600',
        },
        addressHelper: {
          ...font.meta,
          color: colors.textDim,
          marginTop: s(1),
          lineHeight: 18,
        },
        skipLinkWrap: {
          marginTop: s(2.4),
          alignItems: 'center',
        },
        skipLinkText: {
          color: colors.muted,
          fontWeight: '900',
          textDecorationLine: 'underline',
          textDecorationColor: colors.muted,
        },
        backBtn: {
          marginTop: s(2.5),
          alignItems: 'center',
        },
        backBtnText: {
          color: colors.muted,
          fontWeight: '900',
          textDecorationLine: 'underline',
          textDecorationColor: colors.muted,
        },
        legalCard: {
          marginTop: s(2.8),
          borderRadius: 18,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.78)',
          padding: s(2.2),
          gap: s(1.4),
        },
        legalToggle: {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: s(1.8),
        },
        legalCheckbox: {
          width: 22,
          height: 22,
          borderRadius: 7,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.92)',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        },
        legalCheckboxActive: {
          backgroundColor: colors.text,
          borderColor: colors.text,
        },
        legalCopy: {
          flex: 1,
          gap: s(0.6),
        },
        legalTitle: {
          color: colors.text,
          fontSize: 13,
          lineHeight: 19,
          fontWeight: '800',
        },
        legalHint: {
          ...font.meta,
          color: colors.textDim,
          lineHeight: 18,
        },
        legalLinkBtn: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: s(2),
          borderRadius: 14,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.92)',
          paddingHorizontal: s(2.2),
          paddingVertical: s(1.8),
        },
        legalLinkText: {
          color: colors.muted,
          fontSize: 12,
          fontWeight: '900',
          letterSpacing: 0.2,
        },
        pickerBackdrop: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.42)',
          justifyContent: 'flex-end',
        },
        pickerSheet: {
          borderTopLeftRadius: 26,
          borderTopRightRadius: 26,
          paddingHorizontal: s(4),
          paddingTop: s(2.4),
          paddingBottom: insets.bottom + s(4),
          backgroundColor: colors.bg,
          borderTopWidth: hairline,
          borderTopColor: colors.borderLight,
          gap: s(2.2),
        },
        pickerHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        pickerTitle: {
          ...font.h2,
          color: colors.text,
          marginBottom: 0,
        },
        pickerAction: {
          minHeight: 34,
          paddingHorizontal: s(1.8),
          borderRadius: 999,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.88)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        pickerActionPrimary: {
          backgroundColor: colors.text,
          borderColor: colors.text,
        },
        pickerActionText: {
          ...font.meta,
          color: colors.text,
          fontWeight: '900',
        },
        pickerActionPrimaryText: {
          color: '#fff',
        },
        pickerPreview: {
          ...font.h2,
          color: colors.text,
          textAlign: 'center',
          marginBottom: s(0.4),
        },
        pickerRow: {
          flexDirection: 'row',
          gap: s(1.4),
        },
      }),
    [colors, insets.top, insets.bottom, isDark, windowHeight]
  );

  const resetError = () => setError(null);

  const dobDayOptions = useMemo(
    () =>
      Array.from({ length: getDaysInMonth(dobYear, dobMonth) }, (_, index) => ({
        value: index + 1,
        label: padDobPart(index + 1),
      })),
    [dobMonth, dobYear]
  );
  const dobYearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 121 }, (_, index) => ({
      value: currentYear - index,
      label: String(currentYear - index),
    }));
  }, []);

  useEffect(() => {
    const maxDay = getDaysInMonth(dobYear, dobMonth);
    if (dobDay > maxDay) {
      setDobDay(maxDay);
    }
  }, [dobDay, dobMonth, dobYear]);

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (!res.canceled && res.assets?.[0]?.uri) {
      setPhotoUri(res.assets[0].uri);
    }
  };

  const onLogin = async () => {
    resetError();
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err: any) {
      setError(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const validateSignupBasics = () => {
    const normalized = normalizeUsername(username);
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return null;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return null;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return null;
    }
    if (!USERNAME_RE.test(normalized)) {
      setError('Username must be 3-20 chars and use letters, numbers, . or _.');
      return null;
    }
    if (!displayName.trim()) {
      setError('Display name is required.');
      return null;
    }
    if (!isDobString(dateOfBirth)) {
      setError('Select your date of birth.');
      return null;
    }
    const adult = isAdultFromDob(dateOfBirth);
    if (!adult) {
      setError('You must be 18+ to create an account.');
      return null;
    }
    if (bio.trim().length > 200) {
      setError('Bio must be 200 characters or less.');
      return null;
    }
    return { normalized };
  };

  const buildSignupAddress = () =>
    sanitizeShippingAddress({
      name: shippingName,
      line1: shippingLine1,
      line2: shippingLine2,
      city: shippingCity,
      region: shippingRegion,
      postalCode: shippingPostalCode,
      country: shippingCountry,
    } satisfies Partial<ShippingAddress>);

  const proceedToAddress = () => {
    resetError();
    const basics = validateSignupBasics();
    if (!basics) return;
    if (!shippingName.trim() && displayName.trim()) {
      setShippingName(displayName.trim());
    }
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSignupStep(2);
  };

  const onSignup = async () => {
    resetError();
    const basics = validateSignupBasics();
    if (!basics) return;
    if (!acceptedLegal) {
      setError('Read the privacy policy and accept the basic terms before creating an account.');
      return;
    }
    const nextShippingAddress = buildSignupAddress();

    setBusy(true);
    try {
      await signUp({
        email,
        password,
        username: basics.normalized,
        displayName,
        dateOfBirth,
        isAdult: true,
        bio,
        photoUri: photoUri || undefined,
        sexPreference,
        shippingAddress: nextShippingAddress,
        legalPolicyVersionAccepted: PRIVACY_POLICY_VERSION,
      });
    } catch (err: any) {
      setError(formatAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const headerTranslate = enterAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });
  const cardTranslate = enterAnim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });
  const cardOpacity = modeAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const modeShift = modeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -s(2)] });
  const keyboardShiftLogin = keyboardAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -s(7.5)] });
  const keyboardShiftSignup = keyboardAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -s(5)] });

  const openDobPicker = () => {
    resetError();
    const parsed = parseDobParts(dateOfBirth);
    const next = parsed || { year: dobYear, month: dobMonth, day: dobDay };
    setDobYear(next.year);
    setDobMonth(next.month);
    setDobDay(next.day);
    setDobPickerOpen(true);
  };

  const closeDobPicker = () => setDobPickerOpen(false);

  const confirmDobPicker = () => {
    setDateOfBirth(formatDobParts(dobYear, dobMonth, dobDay));
    setDobPickerOpen(false);
  };

  const signupPrimaryAction = signupStep === 1 ? proceedToAddress : onSignup;
  const signupPrimaryLabel =
    signupStep === 1 ? 'Proceed to address' : busy ? 'Please wait...' : 'Create account';
  const authLogo = isDark
    ? require('../../assets/app logo dark.png')
    : require('../../assets/app logo light.png');

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={
          isDark
            ? ['rgba(25,25,30,0.9)', 'rgba(5,5,7,1)']
            : ['rgba(255,255,255,1)', 'rgba(230,233,240,1)']
        }
        style={styles.gradient}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        enabled={false}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Animated.View
            style={{
              opacity: enterAnim,
              transform: [{ translateY: headerTranslate }],
              alignItems: 'center',
            }}
          >
            <View style={styles.headerWrap}>
              <View style={styles.header}>
                <Image source={authLogo} style={styles.logo} resizeMode="contain" />
                <Text style={[styles.brand, { color: colors.text }]}>FSHN</Text>
                <Text style={styles.tagline}>
                  Curated drops, authentic fits, and a wardrobe that evolves with you.
                </Text>
              </View>
            </View>
          </Animated.View>

          <Animated.View
            style={{
              opacity: Animated.multiply(enterAnim, cardOpacity),
              transform: [
                {
                  translateY: Animated.add(
                    Animated.add(cardTranslate, modeShift),
                    mode === 'signup' ? keyboardShiftSignup : keyboardShiftLogin
                  ),
                },
              ],
              flex: 1,
              justifyContent: 'center',
            }}
          >
            <View
              style={[
                styles.cardWrap,
                mode === 'signup' ? styles.cardWrapSignup : styles.cardWrapLogin,
              ]}
            >
              <Glass style={styles.card} tint={isDark ? 'dark' : 'light'} intensity={isDark ? 28 : 22}>
                <Text style={styles.cardTitle}>
                  {mode === 'login'
                    ? 'Sign in'
                    : signupStep === 1
                      ? 'Create your account'
                      : 'Delivery address'}
                </Text>
                <Text style={styles.cardHint}>
                  {mode === 'login'
                    ? 'Welcome back.'
                    : signupStep === 1
                      ? 'Start with your account details and date of birth.'
                      : 'Add the address we should use for marketplace deliveries.'}
                </Text>

                {mode === 'signup' && (
                  <View style={styles.stepRow}>
                    {[
                      { key: 1 as const, label: 'ACCOUNT' },
                      { key: 2 as const, label: 'ADDRESS' },
                    ].map((step) => {
                      const active = signupStep === step.key;
                      const complete = signupStep > step.key;
                      return (
                        <View
                          key={step.key}
                          style={[styles.stepChip, active && styles.stepChipActive]}
                        >
                          <Text
                            style={[
                              styles.stepChipText,
                              !active && styles.stepChipTextDim,
                              active && styles.stepChipTextActive,
                              complete && !active && { color: colors.text },
                            ]}
                          >
                            {step.label}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                )}

                {mode === 'signup' && (
                  <View style={styles.photoRow}>
                    <View style={styles.photoShell}>
                      {photoUri ? (
                        <Image source={{ uri: photoUri }} style={styles.photoImage} />
                      ) : (
                        <Ionicons name="person-circle-outline" size={s(8)} style={styles.photoPlaceholder} />
                      )}
                    </View>
                    <Pressable onPress={pickPhoto}>
                      <Text style={styles.link}>Upload profile photo</Text>
                    </Pressable>
                  </View>
                )}
                <AuthField
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  placeholder="you@email.com"
                  textDim={colors.textDim}
                  fieldLabelStyle={styles.fieldLabel}
                  inputWrapStyle={styles.inputWrap}
                  inputStyle={styles.input}
                  spacing={s(2.5)}
                  onFocus={resetError}
                />
                <AuthField
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  placeholder="••••••••"
                  textDim={colors.textDim}
                  fieldLabelStyle={styles.fieldLabel}
                  inputWrapStyle={styles.inputWrap}
                  inputStyle={styles.input}
                  spacing={s(2.5)}
                  onFocus={resetError}
                />

                {mode === 'signup' && (
                  <>
                    {signupStep === 1 ? (
                      <>
                        <AuthField
                          label="Confirm password"
                          value={confirmPassword}
                          onChangeText={setConfirmPassword}
                          secureTextEntry
                          placeholder="••••••••"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <AuthField
                          label="Username"
                          value={username}
                          onChangeText={(v) => setUsername(v.replace(/\s/g, ''))}
                          placeholder="yourname"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <AuthField
                          label="Display name"
                          value={displayName}
                          onChangeText={setDisplayName}
                          autoCapitalize="words"
                          placeholder="Your name"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <View style={{ marginTop: s(2.5) }}>
                          <Text style={styles.fieldLabel}>Date of birth</Text>
                          <Pressable
                            style={[styles.inputWrap, styles.dateFieldBtn]}
                            onPress={openDobPicker}
                          >
                            <Text
                              style={[
                                styles.dateFieldValue,
                                !dateOfBirth && styles.dateFieldPlaceholder,
                              ]}
                            >
                              {dateOfBirth || 'Select with month, day, and year'}
                            </Text>
                            <Ionicons name="chevron-down" size={16} color={colors.textDim} />
                          </Pressable>
                          <Text style={styles.addressHelper}>
                            This will be saved as a locked YYYY-MM-DD date after signup.
                          </Text>
                        </View>
                        <View style={styles.prefRow}>
                          <Text style={styles.fieldLabel}>Item gender preference</Text>
                          <View style={styles.prefChipWrap}>
                            {SEX_OPTIONS.map((option) => {
                              const selected = sexPreference === option.value;
                              return (
                                <Pressable
                                  key={option.value}
                                  onPress={() => setSexPreference(option.value)}
                                  style={[styles.prefChip, selected && styles.prefChipActive]}
                                >
                                  <Text style={[styles.prefChipText, selected && styles.prefChipTextActive]}>
                                    {option.label}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        </View>
                        <AuthField
                          label="Bio (optional)"
                          value={bio}
                          onChangeText={setBio}
                          autoCapitalize="sentences"
                          placeholder="Short bio (max 200 chars)"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />

                        <Text style={styles.helper}>
                          Your date of birth is used for 18+ access and stays locked after signup.
                        </Text>
                      </>
                    ) : (
                      <>
                        <AuthField
                          label="Recipient name"
                          value={shippingName}
                          onChangeText={setShippingName}
                          autoCapitalize="words"
                          placeholder="Full name"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <AuthField
                          label="Address line 1"
                          value={shippingLine1}
                          onChangeText={setShippingLine1}
                          autoCapitalize="words"
                          placeholder="Street address"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <AuthField
                          label="Address line 2 (optional)"
                          value={shippingLine2}
                          onChangeText={setShippingLine2}
                          autoCapitalize="words"
                          placeholder="Apartment, suite, etc."
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <AuthField
                          label="City"
                          value={shippingCity}
                          onChangeText={setShippingCity}
                          autoCapitalize="words"
                          placeholder="City"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <AuthField
                          label="State / region"
                          value={shippingRegion}
                          onChangeText={setShippingRegion}
                          autoCapitalize="words"
                          placeholder="State or region"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <AuthField
                          label="Postal code"
                          value={shippingPostalCode}
                          onChangeText={setShippingPostalCode}
                          autoCapitalize="characters"
                          placeholder="Postal code"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <AuthField
                          label="Country"
                          value={shippingCountry}
                          onChangeText={setShippingCountry}
                          autoCapitalize="words"
                          placeholder="Country"
                          textDim={colors.textDim}
                          fieldLabelStyle={styles.fieldLabel}
                          inputWrapStyle={styles.inputWrap}
                          inputStyle={styles.input}
                          spacing={s(2.5)}
                          onFocus={resetError}
                        />
                        <Text style={styles.addressHelper}>
                          This step is optional right now. You can add it now or later in Settings, but checkout will still require a complete delivery address.
                        </Text>
                      </>
                    )}

                    <View style={styles.legalCard}>
                      <Pressable
                        style={({ pressed }) => [styles.legalToggle, pressFeedback(pressed, 'subtle')]}
                        onPress={() => {
                          resetError();
                          setAcceptedLegal((value) => !value);
                        }}
                      >
                        <View
                          style={[
                            styles.legalCheckbox,
                            acceptedLegal && styles.legalCheckboxActive,
                          ]}
                        >
                          {acceptedLegal ? (
                            <Ionicons name="checkmark" size={14} color="#fff" />
                          ) : null}
                        </View>
                        <View style={styles.legalCopy}>
                          <Text style={styles.legalTitle}>
                            I have read the privacy policy and accept the basic terms and conditions.
                          </Text>
                          <Text style={styles.legalHint}>
                            Required before account creation. Short policy updated{' '}
                            {PRIVACY_POLICY_LAST_UPDATED}.
                          </Text>
                        </View>
                      </Pressable>

                      <Pressable
                        style={({ pressed }) => [styles.legalLinkBtn, pressFeedback(pressed, 'subtle')]}
                        onPress={() => {
                          resetError();
                          onOpenPrivacyPolicy?.();
                        }}
                      >
                        <Text style={styles.legalLinkText}>Read privacy policy</Text>
                        <Ionicons name="open-outline" size={15} color={colors.muted} />
                      </Pressable>
                    </View>
                  </>
                )}

                {error && <Text style={styles.error}>{error}</Text>}

                <Pressable
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    pressed && { transform: [{ scale: 0.98 }] },
                    busy && { opacity: 0.6 },
                  ]}
                  onPress={mode === 'login' ? onLogin : signupPrimaryAction}
                  disabled={busy}
                >
                  <Text style={styles.primaryText}>
                    {mode === 'login'
                      ? busy
                        ? 'Please wait...'
                        : 'Sign in'
                      : signupPrimaryLabel}
                  </Text>
                </Pressable>

                {mode === 'signup' && signupStep === 2 && (
                  <Pressable
                    style={styles.backBtn}
                    onPress={() => {
                      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                      setSignupStep(1);
                      resetError();
                    }}
                    disabled={busy}
                  >
                    <Text style={styles.backBtnText}>Back to account details</Text>
                  </Pressable>
                )}

                {mode === 'signup' && signupStep === 1 && (
                  <Pressable
                    style={styles.skipLinkWrap}
                    onPress={onSignup}
                    disabled={busy}
                  >
                    <Text style={styles.skipLinkText}>
                      Skip address for now and create account
                    </Text>
                  </Pressable>
                )}

                {mode === 'login' ? (
                  <Pressable
                    style={styles.secondaryBtn}
                    onPress={() => switchMode('signup')}
                    disabled={busy}
                  >
                    <Text style={styles.secondaryText}>Create account</Text>
                  </Pressable>
                ) : (
                  <View style={styles.footerRow}>
                    <Pressable onPress={() => switchMode('login')} disabled={busy}>
                      <Text style={styles.footerLink}>Already have an account? Sign in</Text>
                    </Pressable>
                  </View>
                )}
              </Glass>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={dobPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={closeDobPicker}
      >
        <View style={styles.pickerBackdrop}>
          <Pressable style={{ flex: 1 }} onPress={closeDobPicker} />
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHeader}>
              <Pressable style={styles.pickerAction} onPress={closeDobPicker}>
                <Text style={styles.pickerActionText}>Cancel</Text>
              </Pressable>
              <Text style={styles.pickerTitle}>Select date of birth</Text>
              <Pressable
                style={[styles.pickerAction, styles.pickerActionPrimary]}
                onPress={confirmDobPicker}
              >
                <Text style={[styles.pickerActionText, styles.pickerActionPrimaryText]}>Done</Text>
              </Pressable>
            </View>

            <Text style={styles.pickerPreview}>{formatDobParts(dobYear, dobMonth, dobDay)}</Text>

            <View style={styles.pickerRow}>
              <WheelColumn
                label="Month"
                options={DOB_MONTHS.map((month) => ({ value: month.value, label: month.label }))}
                selectedValue={dobMonth}
                onValueChange={setDobMonth}
                colors={colors}
                isDark={isDark}
              />
              <WheelColumn
                label="Day"
                options={dobDayOptions}
                selectedValue={dobDay}
                onValueChange={setDobDay}
                colors={colors}
                isDark={isDark}
              />
              <WheelColumn
                label="Year"
                options={dobYearOptions}
                selectedValue={dobYear}
                onValueChange={setDobYear}
                colors={colors}
                isDark={isDark}
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function formatAuthError(err: any) {
  const code = err?.code || err?.message || '';
  if (code.includes('auth/invalid-email')) return 'Enter a valid email address.';
  if (code.includes('auth/wrong-password')) return 'Incorrect password.';
  if (code.includes('auth/user-not-found')) return 'No account found for this email.';
  if (code.includes('auth/email-already-in-use')) return 'Email is already in use.';
  if (code.includes('auth/weak-password')) return 'Password must be at least 6 characters.';
  if (code.includes('USERNAME_TAKEN')) return 'That username is already taken.';
  if (code.includes('INVALID_SHIPPING_ADDRESS')) return 'Add a complete delivery address to create your account.';
  if (code.includes('PRIVACY_ACCEPTANCE_REQUIRED')) {
    return 'Read the privacy policy and accept the basic terms before creating an account.';
  }
  return 'Something went wrong. Please try again.';
}
