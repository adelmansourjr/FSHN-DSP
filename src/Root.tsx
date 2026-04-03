// src/Root.tsx
import React from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Reanimated from 'react-native-reanimated';

import Dock, { TabKey } from './components/Dock';
import TryOnProgressPill from './components/TryOnProgressPill';
import AppStatusBanner from './components/AppStatusBanner';
import HomeScreen from './screens/HomeScreen';
import FeedScreen, { FeedUser } from './screens/FeedScreen';
import StudioScreen from './screens/StudioScreen';
import UploadScreen from './screens/UploadScreen';
import ProfileScreen from './screens/ProfileScreen';
import UserProfileScreen from './screens/UserProfileScreen';
import BasketScreen from './screens/BasketScreen';
import SettingsScreen from './screens/SettingsScreen';
import NotificationsScreen from './screens/NotificationsScreen';
import RecommendationFeedScreen from './screens/RecommendationFeedScreen';
import PrivacyPolicyScreen from './screens/PrivacyPolicyScreen';
import NavContext, { type ProfileScreenRequest } from './navigation/NavContext';
import { CartProvider } from './context/CartContext';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import { STRIPE_PUBLISHABLE_KEY } from './lib/payments/stripe';
import { StripeProviderWrapper } from './lib/payments/stripeNative';
import { s } from './theme/tokens';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppStatusProvider } from './context/AppStatusContext';
import AuthScreen from './screens/AuthScreen';
import type { Item } from './data/mock';
import { createEmptyListingEditorState, type UploadEditorRequest } from './lib/listingEditor';
import type { RecommendationMode } from './lib/recommendations';
import { requestUploadLeave } from './lib/uploadLeaveGuard';

type Route =
  | { name: 'tabs' }
  | { name: 'user'; user: FeedUser }
  | { name: 'basket' }
  | { name: 'settings' }
  | { name: 'notifications' }
  | {
      name: 'recommendation';
      mode: RecommendationMode;
      trendingItems: Item[];
      discoverItems: Item[];
    };

function RootInner() {
  const insets = useSafeAreaInsets();
  const { user: authUser } = useAuth();
  const [tab, setTab] = React.useState<TabKey>('home');
  const lastNonUploadTab = React.useRef<TabKey>('home');
  const [route, setRoute] = React.useState<Route>({ name: 'tabs' });
  const [uploadEditorRequest, setUploadEditorRequest] = React.useState<UploadEditorRequest | null>(null);
  const [profileRequest, setProfileRequest] = React.useState<ProfileScreenRequest | null>(null);
  const { colors } = useTheme();
  const [basketMounted, setBasketMounted] = React.useState(false);
  const basketOpacity = React.useRef(new Animated.Value(0)).current;
  const basketTranslateY = React.useRef(new Animated.Value(18)).current;
  const basketClosing = React.useRef(false);

  const showTabs = route.name === 'tabs';
  const resetUploadComposer = React.useCallback(() => {
    setUploadEditorRequest({
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      mode: { kind: 'create' },
      form: createEmptyListingEditorState(),
    });
  }, []);
  const confirmLeaveUploadIfNeeded = React.useCallback(async () => {
    if (!showTabs || tab !== 'upload') return true;
    const canLeave = await requestUploadLeave();
    if (canLeave) {
      resetUploadComposer();
    }
    return canLeave;
  }, [resetUploadComposer, showTabs, tab]);

  const finishClose = React.useCallback(() => setRoute({ name: 'tabs' }), []);
  const closeBasket = React.useCallback(() => {
    if (!basketMounted || basketClosing.current) return;
    basketClosing.current = true;
    Animated.parallel([
      Animated.timing(basketOpacity, {
        toValue: 0,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(basketTranslateY, {
        toValue: 18,
        duration: 220,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      basketClosing.current = false;
      setBasketMounted(false);
      setRoute({ name: 'tabs' });
    });
  }, [basketMounted, basketOpacity, basketTranslateY]);

  React.useEffect(() => {
    if (route.name !== 'basket') return;
    basketClosing.current = false;
    setBasketMounted(true);
    basketOpacity.setValue(0);
    basketTranslateY.setValue(18);
    Animated.parallel([
      Animated.timing(basketOpacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(basketTranslateY, {
        toValue: 0,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [route.name, basketOpacity, basketTranslateY]);

  React.useEffect(() => {
    if (route.name === 'tabs' && tab !== 'upload') {
      lastNonUploadTab.current = tab;
    }
  }, [route.name, tab]);

  // Dock: if you’re on a user profile, tab taps first return to tabs
  const onDockChange = React.useCallback(async (next: TabKey) => {
    if (next !== tab) {
      const canLeave = await confirmLeaveUploadIfNeeded();
      if (!canLeave) return;
    }
    if (route.name === 'basket') {
      closeBasket();
    } else if (!showTabs) {
      setRoute({ name: 'tabs' });
    }
    setTab(next);
  }, [closeBasket, confirmLeaveUploadIfNeeded, route.name, showTabs, tab]);

  const openFeedUser = React.useCallback((user: FeedUser) => {
    if (authUser?.uid && String(user?.id || '').trim() === authUser.uid) {
      setRoute({ name: 'tabs' });
      setTab('profile');
      return;
    }
    setRoute({ name: 'user', user });
  }, [authUser?.uid]);

  const renderTabPane = React.useCallback(
    (key: TabKey, node: React.ReactNode) => {
      const isCurrent = tab === key;
      const interactive = showTabs && isCurrent;
      return (
        <View
          key={key}
          style={[
            StyleSheet.absoluteFill,
            styles.tabPane,
            isCurrent ? styles.tabPaneCurrent : styles.tabPaneHidden,
          ]}
          pointerEvents={interactive ? 'auto' : 'none'}
        >
          {node}
        </View>
      );
    },
    [showTabs, tab]
  );

  // Pill vertical anchor: align with Try On button center but allow easy adjustment
  const pillBottom = insets.bottom + s(18) + 28;

  return (
    <NavContext.Provider
      value={{
        navigate: async (r) => {
          const targetName = String((r as any)?.name || '').trim();
          const stayingOnSameTab = targetName === 'tabs';
          if (!stayingOnSameTab) {
            const canLeave = await confirmLeaveUploadIfNeeded();
            if (!canLeave) return;
          }
          const nextRoute =
            targetName === 'user' && !(r as any)?.user && (r as any)?.params?.user
              ? ({ ...(r as any), user: (r as any).params.user } as any)
              : (r as any);
          if (
            targetName === 'user' &&
            authUser?.uid &&
            String((nextRoute as any)?.user?.id || '').trim() === authUser.uid
          ) {
            setRoute({ name: 'tabs' });
            setTab('profile');
            return;
          }
          setRoute(nextRoute);
        },
        goToTryOn: async () => {
          const canLeave = await confirmLeaveUploadIfNeeded();
          if (!canLeave) return;
          setRoute({ name: 'tabs' });
          setTab('tryon');
        },
        goToTab: async (nextTab) => {
          if (nextTab !== tab) {
            const canLeave = await confirmLeaveUploadIfNeeded();
            if (!canLeave) return;
          }
          setRoute({ name: 'tabs' });
          setTab(nextTab);
        },
        openUploadEditor: async (request) => {
          const canLeave = await confirmLeaveUploadIfNeeded();
          if (!canLeave) return;
          setRoute({ name: 'tabs' });
          setTab('upload');
          setUploadEditorRequest({
            ...request,
            requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          });
        },
        openProfileClosetAdd: async () => {
          const canLeave = await confirmLeaveUploadIfNeeded();
          if (!canLeave) return;
          setRoute({ name: 'tabs' });
          setTab('profile');
          setProfileRequest({
            requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            tab: 'closet',
            openAddCloset: true,
          });
        },
        leaveUpload: async () => {
          const canLeave = await confirmLeaveUploadIfNeeded();
          if (!canLeave) return;
          setRoute({ name: 'tabs' });
          setTab(lastNonUploadTab.current === 'upload' ? 'home' : lastNonUploadTab.current);
        },
      }}
    >
      <CartProvider>
        <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={['left', 'right']}>
          <View style={styles.content}>
            {/* Base tabs (kept mounted so the feed remains visible behind overlays) */}
            <View style={styles.tabHost} pointerEvents={showTabs ? 'auto' : 'none'}>
              {renderTabPane('home', <HomeScreen isActive={showTabs && tab === 'home'} />)}
              {renderTabPane('feed', <FeedScreen onOpenUser={openFeedUser} isActive={showTabs && tab === 'feed'} />)}
              {renderTabPane('tryon', <StudioScreen />)}
              {renderTabPane('upload', <UploadScreen editorRequest={uploadEditorRequest} />)}
              {renderTabPane('profile', <ProfileScreen request={profileRequest} />)}
            </View>

            {/* Overlay: Public user profile (swipe down to dismiss) */}
            {!showTabs && route.name === 'user' && (
              <Reanimated.View style={[StyleSheet.absoluteFill, styles.overlay]}>
                <UserProfileScreen user={(route as any).user} onClose={finishClose} />
              </Reanimated.View>
            )}

            {/* Recommendation feed screen overlay */}
            {!showTabs && route.name === 'recommendation' && (
              <Reanimated.View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: colors.bg }]}>
                <RecommendationFeedScreen
                  initialMode={(route as any).mode}
                  trendingItems={(route as any).trendingItems || []}
                  discoverItems={(route as any).discoverItems || []}
                  onClose={finishClose}
                />
              </Reanimated.View>
            )}

            {/* Basket screen overlay */}
            {(route.name === 'basket' || basketMounted) && (
              <Animated.View
                style={[
                  StyleSheet.absoluteFill,
                  styles.overlay,
                  {
                    backgroundColor: colors.bg,
                    opacity: basketOpacity,
                    transform: [{ translateY: basketTranslateY }],
                  },
                ]}
              >
                <BasketScreen onClose={closeBasket} />
              </Animated.View>
            )}

            {/* Settings screen overlay */}
            {route.name === 'settings' && (
              <Reanimated.View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: colors.bg }]}>
                <SettingsScreen onClose={finishClose} />
              </Reanimated.View>
            )}

            {route.name === 'notifications' && (
              <Reanimated.View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: colors.bg }]}>
                <NotificationsScreen onClose={finishClose} />
              </Reanimated.View>
            )}
          </View>

          {/* Try-on pill overlay anchored above the dock */}
          <View style={{ position: 'absolute', left: 0, right: 0, alignItems: 'center', bottom: pillBottom * 0.75, zIndex: 50 }} pointerEvents="box-none">
            <TryOnProgressPill goToTryOn={() => { setRoute({ name: 'tabs' }); setTab('tryon'); }} />
          </View>

          {/* Dock overlays content; tap always works as escape hatch */}
          <Dock active={tab} onChange={onDockChange} />
        </SafeAreaView>
      </CartProvider>
    </NavContext.Provider>
  );
}

function RootGate() {
  const { user, loading } = useAuth();
  const { colors } = useTheme();
  const [showPrivacyPolicy, setShowPrivacyPolicy] = React.useState(false);

  if (loading) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]}>
        <AppStatusBanner />
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <View style={styles.root}>
        <AuthScreen onOpenPrivacyPolicy={() => setShowPrivacyPolicy(true)} />
        {showPrivacyPolicy && (
          <Reanimated.View
            style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: colors.bg }]}
          >
            <PrivacyPolicyScreen onClose={() => setShowPrivacyPolicy(false)} />
          </Reanimated.View>
        )}
        <AppStatusBanner />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <RootInner />
      <AppStatusBanner />
    </View>
  );
}

export default function Root() {
  return (
    <ThemeProvider>
      <AppStatusProvider>
        <StripeProviderWrapper publishableKey={STRIPE_PUBLISHABLE_KEY || 'pk_test_YOUR_PUBLISHABLE_KEY'}>
          <AuthProvider>
            <RootGate />
          </AuthProvider>
        </StripeProviderWrapper>
      </AppStatusProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1 },
  tabHost: { flex: 1, position: 'relative' },
  tabPane: {},
  tabPaneCurrent: { zIndex: 3 },
  tabPaneHidden: { opacity: 0, zIndex: 1 },

  // overlay sheet container
  overlay: {
    zIndex: 30,
  },

  // top area with a floating close button
  topControls: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    alignItems: 'center',
    zIndex: 40,
  },
  closeBtn: {
    height: 34,
    width: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.12)',
  },
});
