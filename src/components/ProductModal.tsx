import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	Animated,
	Alert,
	Dimensions,
	Modal,
	PanResponder,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { doc, onSnapshot } from 'firebase/firestore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, font, hairline, s } from '../theme/tokens';
import { mock } from '../data/mock';
import { ensureAssetUri } from '../data/assets';
import { useNav } from '../navigation/NavContext';
import { buildSelectionFromProduct, setTryOnSelection } from '../tryon/selection';
import { useCart } from '../context/CartContext';
import { db } from '../lib/firebase';
import { formatCompactCount } from '../lib/formatCounts';
import { toGBPPriceLabel } from '../lib/currency';
import { listingDataToProductLike } from '../lib/firestoreMappers';
import { Haptics, impactAsync, selectionAsync } from '../lib/haptics';
import { pressFeedback } from '../theme/pressFeedback';

export type ProductPhoto = { uri: string };

export type ProductLike = {
	id?: string;
	listingId?: string | null;
	sellerUid?: string | null;
	sellerUsername?: string | null;
	sellerDisplayName?: string | null;
	sellerAvatarUri?: string | null;
	sellerBio?: string | null;
	orderId?: string | null;
	orderStatus?: string | null;
	shippingName?: string | null;
	shippingAddressLine1?: string | null;
	shippingAddressLine2?: string | null;
	shippingCity?: string | null;
	shippingRegion?: string | null;
	shippingPostalCode?: string | null;
	shippingCountry?: string | null;
	shippingToUid?: string | null;
	shippingPaidLabel?: string | null;
	shippingQuoteLabel?: string | null;
	parcelProfile?: string | null;
	trackingCode?: string | null;
	trackingUrl?: string | null;
	trackingPhase?: string | null;
	trackingPhaseLabel?: string | null;
	purchasedAtLabel?: string | null;
	likeCount?: number | null;
	likes?: number | null;
	title: string;
	description?: string | null;
	brand?: string | null;
	price?: string | null;
	originalPrice?: string | null;
	images?: string[] | null;
	image?: string | null;
	photos?: ProductPhoto[] | null;
	imagePath?: string | null;
	category?: string | null;
	size?: string | null;
	condition?: string | null;
	color?: string | null;
	colorName?: string | null;
	colorHex?: string | null;
	tags?: string[] | null;
};

type Props = {
	visible: boolean;
	product?: ProductLike | null;
	onClose: () => void;
	onTry?: (product: ProductLike) => void;
	onBuy?: (product: ProductLike) => void;
	initialLiked?: boolean;
	onLikeChange?: (liked: boolean, product: ProductLike) => void;
};

type SellerPreview = {
	id: string;
	username: string;
	displayName?: string | null;
	avatarUri?: string | null;
	bio?: string | null;
};

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');
const FULL_OPEN_OFFSET = Math.max(SCREEN_HEIGHT * 0.12, 84);
// Raise the half sheet so more content (title + CTAs) is visible
const HALF_OPEN_OFFSET = SCREEN_HEIGHT * 0.44;
const SAFE_CLOSED_OFFSET = Math.max(SCREEN_HEIGHT, FULL_OPEN_OFFSET + 1);
const SAFE_HALF_OPEN_OFFSET = Math.min(
	Math.max(HALF_OPEN_OFFSET, FULL_OPEN_OFFSET + 1),
	SAFE_CLOSED_OFFSET - 1
);
const HANDLE_REGION = s(20);
const SNAP_POINTS = {
	full: FULL_OPEN_OFFSET,
	half: SAFE_HALF_OPEN_OFFSET,
	closed: SAFE_CLOSED_OFFSET,
} as const;

const HERO_WIDTH = Math.min(SCREEN_WIDTH - s(20), 320);
// Make hero images a bit shorter so title and CTAs fit in half state
const HERO_HEIGHT = HERO_WIDTH * 0.78;
const HERO_HALF_HEIGHT = HERO_WIDTH * 0.58;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const INVALID_IMAGE_URI_TOKENS = new Set(['', 'null', 'undefined', 'nan']);

const toNonNegativeInt = (value: unknown): number => {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.round(n));
};

const firstNonEmptyText = (...values: Array<string | null | undefined>) => {
	for (const value of values) {
		const text = String(value || '').trim();
		if (text) return text;
	}
	return '';
};

const toLikeCountSeed = (value?: ProductLike | null): number => {
	if (!value) return 0;
	if (value.likeCount != null) return toNonNegativeInt(value.likeCount);
	if (value.likes != null) return toNonNegativeInt(value.likes);
	return 0;
};

function normalizeImageUri(value?: string | null): string | null {
	const raw = String(value ?? '').trim();
	if (!raw) return null;
	const lower = raw.toLowerCase();
	if (INVALID_IMAGE_URI_TOKENS.has(lower)) return null;
	if (raw.startsWith('//')) return `https:${raw}`;
	if (lower.startsWith('gs://')) {
		const withoutPrefix = raw.slice(5);
		const slashIdx = withoutPrefix.indexOf('/');
		if (slashIdx <= 0 || slashIdx >= withoutPrefix.length - 1) return null;
		const bucket = withoutPrefix.slice(0, slashIdx);
		const path = withoutPrefix.slice(slashIdx + 1);
		return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
	}
	return raw;
}

const ROLE_TO_CATEGORY: Record<string, string> = {
	top: 'Top',
	bottom: 'Bottom',
	dress: 'Dress',
	outer: 'Outerwear',
	shoes: 'Shoes',
	accessory: 'Accessory',
};

const buildMockFallback = (): ProductLike | null => {
	const pool = [
		...(mock?.recentlyTried ?? []),
		...(mock?.trending ?? []),
		...(mock?.discover ?? []),
	];
	const first = pool.find(Boolean);
	if (!first) return null;
	return {
		id: first.id,
		title: first.title,
		price: first.price ?? null,
		images: first.image ? [first.image] : null,
		category: first.role ? ROLE_TO_CATEGORY[String(first.role)] ?? null : null,
		colorName: first.colorName ?? null,
		colorHex: first.colorHex ?? null,
	};
};

export default function ProductModal({
	visible,
	product,
	onClose,
	onTry,
	onBuy,
	initialLiked = false,
	onLikeChange,
}: Props) {
	const insets = useSafeAreaInsets();
	const nav = useNav();
	const { add, contains, items, remove } = useCart();
	const onCloseRef = useRef(onClose);
	const translateY = useRef(new Animated.Value(SNAP_POINTS.closed)).current;
	const lastSnap = useRef(SNAP_POINTS.closed);
	const dragStart = useRef(SNAP_POINTS.closed);
	const scrollOffset = useRef(0);
	const dragAllowed = useRef(false);
	const openedAtRef = useRef(0);
	const lastImageHapticAtRef = useRef(0);
	const lastCarouselIndexRef = useRef(0);
	const likeCountCacheRef = useRef<Record<string, number>>({});
	const basketNavTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [sheetState, setSheetState] = useState<'closed' | 'half' | 'full'>('closed');
	const [liked, setLiked] = useState(initialLiked);
	const [activeImage, setActiveImage] = useState(0);
	const [failedPhotoUris, setFailedPhotoUris] = useState<Record<string, true>>({});
	const [likeCount, setLikeCount] = useState(0);
	const [resolvedSellerUid, setResolvedSellerUid] = useState<string | null>(null);
	const [sellerPreview, setSellerPreview] = useState<SellerPreview | null>(null);
	const [listingProduct, setListingProduct] = useState<ProductLike | null>(null);
	const [basketToast, setBasketToast] = useState<{ title: string; message?: string } | null>(null);
	const basketToastOpacity = useRef(new Animated.Value(0)).current;
	const basketToastTranslateY = useRef(new Animated.Value(18)).current;
	const basketToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const fallbackProduct = useMemo(buildMockFallback, []);
	const sourceProduct = product ?? fallbackProduct;

	const activeListingId = useMemo(() => {
		if (!sourceProduct) return '';
		const explicit = String(sourceProduct.listingId || '').trim();
		if (explicit) return explicit;
		const rawId = String(sourceProduct.id || '').trim();
		if (rawId.startsWith('listing:')) return rawId.slice('listing:'.length);
		if (rawId.startsWith('real-listing-')) return rawId.slice('real-listing-'.length);
		if (rawId.startsWith('liked-listing:')) return rawId.slice('liked-listing:'.length);
		if (/^[A-Za-z0-9_-]{20,}$/.test(rawId)) return rawId;
		return '';
	}, [sourceProduct]);

	const activeProduct = useMemo(() => {
		if (!sourceProduct) return null;
		if (!listingProduct) return sourceProduct;
		return {
			...sourceProduct,
			...listingProduct,
			listingId: listingProduct.listingId || sourceProduct.listingId || null,
		};
	}, [listingProduct, sourceProduct]);

	const displayLikeCount = useMemo(
		() => formatCompactCount(likeCount),
		[likeCount]
	);

	const fireSelectionHaptic = useCallback(() => {
		void selectionAsync();
	}, []);

	const fireImpactHaptic = useCallback((style = Haptics.ImpactFeedbackStyle.Light) => {
		void impactAsync(style);
	}, []);

	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		return () => {
			if (basketNavTimeoutRef.current) {
				clearTimeout(basketNavTimeoutRef.current);
				basketNavTimeoutRef.current = null;
			}
			if (basketToastTimerRef.current) {
				clearTimeout(basketToastTimerRef.current);
				basketToastTimerRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		setLiked(initialLiked);
	}, [initialLiked, visible]);

	useEffect(() => {
		const seeded = Math.max(
			toLikeCountSeed(activeProduct),
			activeListingId ? toNonNegativeInt(likeCountCacheRef.current[activeListingId]) : 0,
			initialLiked ? 1 : 0
		);
		setLikeCount(seeded);
		if (activeListingId) likeCountCacheRef.current[activeListingId] = seeded;
	}, [activeListingId, activeProduct?.id, activeProduct?.likeCount, activeProduct?.likes, initialLiked]);

	useEffect(() => {
		if (!visible || !activeListingId) {
			setListingProduct(null);
			const explicitSellerUid = String(sourceProduct?.sellerUid || '').trim();
			setResolvedSellerUid(explicitSellerUid || null);
			return;
		}
		const listingRef = doc(db, 'listings', activeListingId);
		return onSnapshot(
			listingRef,
			(snap) => {
				if (!snap.exists()) {
					setListingProduct(null);
					const explicitSellerUid = String(sourceProduct?.sellerUid || '').trim();
					setResolvedSellerUid(explicitSellerUid || null);
					return;
				}
				const data = snap.data() as any;
				const remoteLikeCount = toNonNegativeInt(data?.likeCount);
				const resolvedLikeCount = Math.max(remoteLikeCount, liked ? 1 : 0);
				setLikeCount(resolvedLikeCount);
				likeCountCacheRef.current[activeListingId] = resolvedLikeCount;
				const sellerUid = String(data?.sellerUid || sourceProduct?.sellerUid || '').trim();
				setResolvedSellerUid(sellerUid || null);
				setListingProduct(listingDataToProductLike(activeListingId, data));
			},
			(error) => {
				const explicitSellerUid = String(sourceProduct?.sellerUid || '').trim();
				setListingProduct(null);
				setResolvedSellerUid(explicitSellerUid || null);
				if (error?.code === 'permission-denied') return;
				console.warn('[ProductModal] listing listener error', { activeListingId, error });
			}
		);
	}, [activeListingId, liked, sourceProduct?.sellerUid, visible]);

	useEffect(() => {
		setActiveImage(0);
	}, [visible, activeProduct?.photos, activeProduct?.images, activeProduct?.image]);

	useEffect(() => {
		if (visible) return;
		setBasketToast(null);
		basketToastOpacity.setValue(0);
		basketToastTranslateY.setValue(18);
		if (basketToastTimerRef.current) {
			clearTimeout(basketToastTimerRef.current);
			basketToastTimerRef.current = null;
		}
	}, [basketToastOpacity, basketToastTranslateY, visible]);

	useEffect(() => {
		if (!visible || !resolvedSellerUid) {
			setSellerPreview(null);
			return;
		}
		const sellerRef = doc(db, 'users', resolvedSellerUid);
		return onSnapshot(
			sellerRef,
			(snap) => {
				if (!snap.exists()) {
					setSellerPreview({
						id: resolvedSellerUid,
						username: 'seller',
						displayName: 'Seller',
						avatarUri: '',
						bio: '',
					});
					return;
				}
				const data = snap.data() as any;
				const rawUsername = firstNonEmptyText(
					typeof data?.username === 'string' ? data.username : '',
					typeof data?.displayName === 'string' ? data.displayName : '',
					'seller'
				);
				const username = rawUsername.replace(/^@+/, '') || 'seller';
				const displayName = firstNonEmptyText(
					typeof data?.displayName === 'string' ? data.displayName : '',
					username
				);
				setSellerPreview({
					id: resolvedSellerUid,
					username,
					displayName,
					avatarUri: firstNonEmptyText(data?.photoURL, data?.avatarUri, data?.avatarURL),
					bio: firstNonEmptyText(data?.bio),
				});
			},
			() =>
				setSellerPreview({
					id: resolvedSellerUid,
					username: 'seller',
					displayName: 'Seller',
					avatarUri: '',
					bio: '',
				})
		);
	}, [resolvedSellerUid, visible]);

	const photoUris = useMemo(() => {
		if (!activeProduct) return [];
		const photoList = activeProduct.photos?.map((p) => p.uri) ?? [];
		const imageList = activeProduct.images ?? [];
		const single = activeProduct.image ? [activeProduct.image] : [];
		const combined = [...photoList, ...imageList, ...single]
			.map((uri) => normalizeImageUri(uri))
			.filter((uri): uri is string => Boolean(uri));
		return Array.from(new Set(combined));
	}, [activeProduct]);

	const photos = photoUris.map((uri) => ({ uri }));
	const hasImages = photos.length > 0;

	useEffect(() => {
		setFailedPhotoUris({});
	}, [visible, photoUris.join('|')]);

	useEffect(() => {
		if (activeImage < photos.length) return;
		setActiveImage(0);
	}, [activeImage, photos.length]);

	useEffect(() => {
		lastCarouselIndexRef.current = activeImage;
	}, [activeImage]);

	const markPhotoFailed = useCallback((uri: string) => {
		setFailedPhotoUris((prev) => {
			if (prev[uri]) return prev;
			return { ...prev, [uri]: true };
		});
	}, []);

	const priceLabel = useMemo(() => formatPrice(activeProduct?.price), [activeProduct?.price]);
	const compareAt = useMemo(() => formatPrice(activeProduct?.originalPrice), [activeProduct?.originalPrice]);
	const isPurchasable = !!activeListingId;
	const activeCartItemId = useMemo(() => {
		if (!activeProduct) return '';
		const productId = String(activeProduct.id || '').trim();
		const productTitle = String(activeProduct.title || '').trim();
		const matched = items.find((item) => {
			const itemListingId = String(item.listingId || item.product?.listingId || '').trim();
			if (activeListingId && itemListingId === activeListingId) return true;
			const rawId = String(item.id || '').trim();
			return !!rawId && (rawId === productId || rawId === productTitle);
		});
		return String(matched?.id || '').trim();
	}, [activeListingId, activeProduct, items]);
	const isInCart = useMemo(() => {
		if (activeCartItemId) return true;
		if (!activeProduct) return false;
		return contains({
			id: activeProduct.id || activeProduct.title,
			listingId: activeListingId || undefined,
			product: activeProduct,
		});
	}, [activeCartItemId, activeListingId, activeProduct, contains]);

	const sellerCard = useMemo(() => {
		const sellerId = firstNonEmptyText(sellerPreview?.id, resolvedSellerUid, activeProduct?.sellerUid);
		if (!sellerId) return null;
		const fallbackUsername = firstNonEmptyText(
			activeProduct?.sellerUsername,
			activeProduct?.sellerDisplayName
		).replace(/^@+/, '');
		const username = firstNonEmptyText(sellerPreview?.username, fallbackUsername).replace(/^@+/, '') || 'seller';
		const displayName = firstNonEmptyText(
			sellerPreview?.displayName,
			activeProduct?.sellerDisplayName,
			username
		);
		const avatarUri = firstNonEmptyText(sellerPreview?.avatarUri, activeProduct?.sellerAvatarUri);
		const bio = firstNonEmptyText(sellerPreview?.bio, activeProduct?.sellerBio);
		return {
			id: sellerId,
			username,
			displayName,
			avatarUri,
			bio,
		};
	}, [
		activeProduct?.sellerAvatarUri,
		activeProduct?.sellerBio,
		activeProduct?.sellerDisplayName,
		activeProduct?.sellerUid,
		activeProduct?.sellerUsername,
		resolvedSellerUid,
		sellerPreview,
	]);

	const showBasketToast = useCallback((title: string, message?: string) => {
		setBasketToast({ title, message });
		if (basketToastTimerRef.current) {
			clearTimeout(basketToastTimerRef.current);
			basketToastTimerRef.current = null;
		}
		basketToastOpacity.stopAnimation();
		basketToastTranslateY.stopAnimation();
		basketToastOpacity.setValue(0);
		basketToastTranslateY.setValue(18);
		Animated.parallel([
			Animated.timing(basketToastOpacity, {
				toValue: 1,
				duration: 220,
				useNativeDriver: true,
			}),
			Animated.timing(basketToastTranslateY, {
				toValue: 0,
				duration: 240,
				useNativeDriver: true,
			}),
		]).start();
		basketToastTimerRef.current = setTimeout(() => {
			Animated.parallel([
				Animated.timing(basketToastOpacity, {
					toValue: 0,
					duration: 180,
					useNativeDriver: true,
				}),
				Animated.timing(basketToastTranslateY, {
					toValue: 18,
					duration: 200,
					useNativeDriver: true,
				}),
			]).start(({ finished }) => {
				if (finished) setBasketToast(null);
			});
			basketToastTimerRef.current = null;
		}, 2200);
	}, [basketToastOpacity, basketToastTranslateY]);

	const snapTo = useCallback(
		(point: number, velocity = 0) => {
			lastSnap.current = point;
			if (point === SNAP_POINTS.full) setSheetState('full');
			else if (point === SNAP_POINTS.half) setSheetState('half');
			else setSheetState('closed');
			translateY.stopAnimation();

			Animated.spring(translateY, {
				toValue: point,
				velocity,
				damping: 22,
				stiffness: 260,
				mass: 1,
				useNativeDriver: true,
			}).start(({ finished }) => {
				if (point === SNAP_POINTS.closed) {
					dragAllowed.current = false;
					// Call onClose after the sheet finished sliding down so the close
					// feels like a slide instead of an immediate fade.
					if (finished) onCloseRef.current?.();
					else requestAnimationFrame(() => onCloseRef.current?.());
				}

				// give a small haptic when the sheet finished moving to a snap point
				if (point === SNAP_POINTS.full) {
					void impactAsync(Haptics.ImpactFeedbackStyle.Medium);
				} else {
					void impactAsync(Haptics.ImpactFeedbackStyle.Light);
				}
			});
		},
		[translateY]
	);

	useEffect(() => {
		if (visible) {
			openedAtRef.current = Date.now();
			translateY.setValue(SNAP_POINTS.closed);
			requestAnimationFrame(() => {
				void impactAsync(Haptics.ImpactFeedbackStyle.Light);
				snapTo(SNAP_POINTS.half);
			});
		} else {
			translateY.setValue(SNAP_POINTS.closed);
			lastSnap.current = SNAP_POINTS.closed;
			setSheetState('closed');
		}
	}, [visible, snapTo, translateY]);

	const closeSheet = useCallback(() => snapTo(SNAP_POINTS.closed), [snapTo]);
	const goToBasket = useCallback(() => {
		closeSheet();
		if (basketNavTimeoutRef.current) {
			clearTimeout(basketNavTimeoutRef.current);
			basketNavTimeoutRef.current = null;
		}
		basketNavTimeoutRef.current = setTimeout(() => {
			if (nav.navigate) {
				nav.navigate({ name: 'basket' });
			} else {
				console.warn('[ProductModal] nav.navigate missing for basket');
			}
			basketNavTimeoutRef.current = null;
		}, 220);
	}, [closeSheet, nav]);
	const handleBackdropPress = useCallback(() => {
		// Ignore a backdrop tap that can be fired from the same touch used to open the modal.
		if (Date.now() - openedAtRef.current < 280) return;
		closeSheet();
	}, [closeSheet]);

	// Bias the spring to one of the three snap states for a predictable sheet experience.
	const decideSnapPoint = (nextOffset: number, velocity: number) => {
		if (velocity > 1.2) return SNAP_POINTS.closed;
		if (velocity < -1.2) return SNAP_POINTS.full;

		if (nextOffset < (SNAP_POINTS.half + SNAP_POINTS.full) / 2) return SNAP_POINTS.full;
		if (nextOffset < (SNAP_POINTS.closed + SNAP_POINTS.half) / 2) return SNAP_POINTS.half;
		return SNAP_POINTS.closed;
	};

	const baseGestureCheck = (_: any, gesture: any) => {
		const vertical = Math.abs(gesture.dy) > Math.abs(gesture.dx);
		if (!vertical || Math.abs(gesture.dy) < 4) return false;
		if (gesture.dy > 0 && lastSnap.current === SNAP_POINTS.full && scrollOffset.current > 6) {
			return false; // let content scroll when fully expanded and not at top.
		}
		return true;
	};
	const canStartFromHandle = () => {
		dragAllowed.current = true;
		return true;
	};

	const shouldCaptureGesture = (_evt: any, gesture: any) => {
		if (!dragAllowed.current) return false;
		return baseGestureCheck(null, gesture);
	};

	const panResponder = useRef(
		PanResponder.create({
			onStartShouldSetPanResponder: canStartFromHandle,
			onStartShouldSetPanResponderCapture: canStartFromHandle,
			onMoveShouldSetPanResponderCapture: shouldCaptureGesture,
			onMoveShouldSetPanResponder: shouldCaptureGesture,
			onPanResponderGrant: () => {
				dragStart.current = lastSnap.current;
				// subtle selection haptic when user starts dragging the handle
				void selectionAsync();
			},
			onPanResponderMove: (_, gesture) => {
				if (!dragAllowed.current) return;
				const next = clamp(dragStart.current + gesture.dy, SNAP_POINTS.full, SNAP_POINTS.closed);
				translateY.setValue(next);
			},
			onPanResponderRelease: (_, gesture) => {
				if (!dragAllowed.current) return;
				const next = clamp(dragStart.current + gesture.dy, SNAP_POINTS.full, SNAP_POINTS.closed);
				const target = decideSnapPoint(next, gesture.vy);
				snapTo(target, gesture.vy);
				dragAllowed.current = false;
				// small selection haptic on release
				void selectionAsync();
			},
			onPanResponderTerminate: () => {
				dragAllowed.current = false;
			},
			onPanResponderTerminationRequest: () => false,
		})
	).current;

	const overlayOpacity = translateY.interpolate({
		inputRange: [SNAP_POINTS.full, SNAP_POINTS.closed],
		outputRange: [0.6, 0],
		extrapolate: 'clamp',
	});

	const toggleLike = () => {
		if (!activeProduct) return;
		const next = !liked;
		setLiked(next);
		setLikeCount((current) => {
			const nextCount = Math.max(0, current + (next ? 1 : -1));
			if (activeListingId) likeCountCacheRef.current[activeListingId] = nextCount;
			return nextCount;
		});
		fireImpactHaptic(next ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
		onLikeChange?.(
			next,
			activeListingId
				? { ...activeProduct, listingId: activeListingId }
				: activeProduct
		);
	};

	const handleOpenSeller = useCallback(() => {
		if (!sellerCard?.id) return;
		fireSelectionHaptic();
		nav.navigate({
			name: 'user',
			user: {
				id: sellerCard.id,
				username: sellerCard.username,
				displayName: sellerCard.displayName || sellerCard.username,
				avatarUri: sellerCard.avatarUri || '',
				bio: sellerCard.bio || '',
				source: 'real',
			},
		} as any);
		closeSheet();
	}, [closeSheet, fireSelectionHaptic, nav, sellerCard]);

	if (!visible || !activeProduct) return null;

	const handleTry = async () => {
		fireImpactHaptic(Haptics.ImpactFeedbackStyle.Light);
		if (!activeProduct) {
			console.warn('[TryNow] missing activeProduct');
			return;
		}
		let resolvedProduct = activeProduct;
		if (activeProduct.imagePath) {
			try {
				const resolvedUri = await ensureAssetUri(activeProduct.imagePath);
				if (resolvedUri) {
					resolvedProduct = {
						...activeProduct,
						image: resolvedUri,
						images: [resolvedUri],
						photos: [{ uri: resolvedUri }],
					};
				}
			} catch (err) {
				console.warn('[TryNow] asset resolve failed', err);
			}
		}
		const selection = buildSelectionFromProduct(resolvedProduct);
		if (!selection) {
			console.warn('[TryNow] failed to build selection');
			return;
		}
		console.log('[TryNow] selection built', selection);
		setTryOnSelection(selection);
		if (nav.goToTryOn) {
			console.log('[TryNow] navigating to Studio');
			nav.goToTryOn();
		} else {
			console.warn('[TryNow] nav.goToTryOn missing');
		}
		onTry?.(activeProduct);
	};

	const handleBuy = () => {
		fireImpactHaptic(Haptics.ImpactFeedbackStyle.Medium);
		if (!activeProduct) return;
		if (!isPurchasable) {
			Alert.alert(
				'Not for sale',
				'Closet items are for styling and try-on only. Only marketplace listings can be purchased.'
			);
			return;
		}
		if (isInCart) {
			goToBasket();
			return;
		}
		add({
			id: activeProduct.id || activeProduct.title,
			listingId: activeListingId || undefined,
			sellerUid: activeProduct.sellerUid || undefined,
			title: activeProduct.title,
			price: parsePrice(activeProduct.price),
			uri: activeProduct.images?.[0] || activeProduct.image || activeProduct.photos?.[0]?.uri,
			qty: 1,
			product: activeProduct,
		});
		onBuy?.(activeProduct);
		showBasketToast('Added to basket', `${activeProduct.title} is in your basket.`);
	};

	const handleRemoveFromBasket = () => {
		if (!activeCartItemId || !activeProduct) return;
		fireImpactHaptic(Haptics.ImpactFeedbackStyle.Light);
		remove(activeCartItemId);
		showBasketToast('Removed from basket', `${activeProduct.title} was removed.`);
	};

	const buyButtonLabel = isInCart ? 'Go to basket' : !isPurchasable ? 'Not for sale' : 'Add to basket';

	const meta = [
		{ label: 'Category', value: activeProduct.category },
		{ label: 'Size', value: activeProduct.size },
		{ label: 'Condition', value: activeProduct.condition },
		{ label: 'Color', value: activeProduct.color ?? activeProduct.colorName },
		{ label: 'Brand', value: activeProduct.brand },
	].filter((m) => m.value);

	const heroHeight = sheetState === 'half' ? HERO_HALF_HEIGHT : HERO_HEIGHT;
	const heroHeightStyle = { height: heroHeight };

	return (
		// Use `none` so the modal container doesn't fade — we control the sheet animation ourselves
		<Modal
			transparent
			visible={visible}
			animationType="none"
			onRequestClose={closeSheet}
			presentationStyle="overFullScreen"
			statusBarTranslucent
		>
			<Animated.View
				pointerEvents="none"
				style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(11,11,14,0.8)', opacity: overlayOpacity }]}
			/>

			<Pressable style={StyleSheet.absoluteFill} onPress={handleBackdropPress} />

			<Animated.View
				style={[styles.sheet, { transform: [{ translateY }] }]}
				pointerEvents="box-none"
			>
				<BlurView intensity={50} tint="light" style={styles.glass}>
					<View style={styles.handleZone} {...panResponder.panHandlers}>
						<View style={styles.handle} />
					</View>

					<ScrollView
						showsVerticalScrollIndicator={false}
						contentContainerStyle={styles.content}
						onScroll={(evt) => {
							scrollOffset.current = evt.nativeEvent.contentOffset.y;
						}}
						scrollEventThrottle={16}
					>
						<View style={styles.heroComposite}>
							<View style={[styles.carouselWrap, styles.carouselWrapRelative]}>
								{hasImages ? (
									<ScrollView
										horizontal
										pagingEnabled
										showsHorizontalScrollIndicator={false}
										style={styles.carousel}
										onScroll={(evt) => {
											const width = evt.nativeEvent.layoutMeasurement.width || HERO_WIDTH;
											const rawIdx = Math.round(evt.nativeEvent.contentOffset.x / width);
											const idx = clamp(rawIdx, 0, Math.max(photos.length - 1, 0));
											if (idx !== lastCarouselIndexRef.current) {
												lastCarouselIndexRef.current = idx;
												setActiveImage(idx);
												const now = Date.now();
												if (now - lastImageHapticAtRef.current > 120) {
													lastImageHapticAtRef.current = now;
													fireSelectionHaptic();
												}
											}
										}}
										scrollEventThrottle={16}
									>
											{photos.map((photo) => (
												<View key={photo.uri} style={[styles.heroFrame, heroHeightStyle]}>
													{failedPhotoUris[photo.uri] ? (
														<View style={[styles.heroErrorState, heroHeightStyle]}>
															<Ionicons name="image-outline" size={28} color={colors.textDim} />
															<Text style={styles.heroErrorText}>Image unavailable</Text>
														</View>
													) : (
														<ExpoImage
															source={{ uri: photo.uri }}
															style={[styles.heroImage, heroHeightStyle]}
															contentFit="contain"
															contentPosition="center"
															cachePolicy="memory"
															onError={() => markPhotoFailed(photo.uri)}
														/>
													)}
												</View>
											))}
										</ScrollView>
									) : (
										<View style={[styles.emptyImage, heroHeightStyle]}>
											<Ionicons name="image-outline" size={32} color={colors.textDim} />
											<Text style={styles.emptyImageText}>Add photos to preview</Text>
										</View>
									)}

								{hasImages && (
									<View style={styles.pagination}>
										{photos.map((_, idx) => (
											<View
												key={String(idx)}
												style={[styles.dot, idx === activeImage && styles.dotActive]}
											/>
										))}
									</View>
								)}
							</View>
						</View>

						{/* Title, price and compact CTAs shown in half state */}
						<View style={[styles.titleBlock, sheetState === 'half' && styles.titleBlockHalf]}>
							<View style={styles.titleRow}>
								<Text numberOfLines={2} style={styles.title}>{activeProduct.title}</Text>
								{isInCart && (
									<Pressable
										onPressIn={fireSelectionHaptic}
										onPress={handleRemoveFromBasket}
										style={({ pressed }) => [
											styles.basketRemoveChip,
											pressFeedback(pressed, 'subtle'),
										]}
									>
										<Ionicons name="trash-outline" size={14} color={colors.danger} />
										<Text style={styles.basketRemoveChipText}>Remove from basket</Text>
									</Pressable>
								)}
							</View>
							{sellerCard && (
								<View style={styles.sellerSection}>
									<Text style={styles.sellerEyebrow}>Seller</Text>
									<Pressable
										onPressIn={fireSelectionHaptic}
										onPress={handleOpenSeller}
										style={({ pressed }) => [
											styles.sellerCard,
											pressFeedback(pressed, 'subtle'),
										]}
										accessibilityLabel="Open seller profile"
									>
										<View style={styles.sellerAvatarShell}>
											{sellerCard.avatarUri ? (
												<ExpoImage source={{ uri: sellerCard.avatarUri }} style={styles.sellerAvatar} contentFit="cover" />
											) : (
												<Ionicons name="person-outline" size={14} color={colors.textDim} />
											)}
										</View>
										<View style={styles.sellerTextWrap}>
											<Text numberOfLines={1} style={styles.sellerDisplayName}>{sellerCard.displayName}</Text>
											<Text numberOfLines={1} style={styles.sellerUsername}>@{sellerCard.username}</Text>
										</View>
										<Ionicons name="chevron-forward" size={15} color={colors.textDim} />
									</Pressable>
								</View>
							)}
								<View style={styles.priceRow}>
									<View style={styles.priceBlock}>
										{priceLabel ? <Text style={styles.price}>{priceLabel}</Text> : null}
										{compareAt ? <Text style={styles.compareAt}>{compareAt}</Text> : null}
									</View>
							<Pressable
								onPressIn={fireSelectionHaptic}
								onPress={toggleLike}
								style={({ pressed }) => [styles.likePill, pressFeedback(pressed, 'subtle')]}
								accessibilityLabel="Like"
									>
									<Ionicons name={liked ? 'heart' : 'heart-outline'} size={18} color={liked ? colors.danger : colors.textDim} />
									<Text style={styles.likeCountText}>{displayLikeCount}</Text>
								</Pressable>
							</View>
				{sheetState !== 'closed' && (
								<View style={[styles.compactCtaRow, sheetState === 'half' && styles.compactCtaRowHalf]}>
									<Pressable
										onPressIn={fireSelectionHaptic}
										onPress={handleTry}
										style={({ pressed }) => [
											styles.compactBtn,
											styles.compactSecondary,
											pressFeedback(pressed),
										]}
									>
										<Ionicons name="sparkles-outline" size={16} color={colors.text} />
										<Text style={styles.compactSecondaryText}>Try now</Text>
									</Pressable>
									<Pressable
										onPressIn={fireSelectionHaptic}
										onPress={handleBuy}
										disabled={!isPurchasable}
										style={({ pressed }) => [
											styles.compactBtn,
											styles.compactPrimary,
											!isPurchasable && styles.disabledBtn,
											isPurchasable ? pressFeedback(pressed) : null,
										]}
									>
										<Text style={styles.compactPrimaryText}>{buyButtonLabel}</Text>
									</Pressable>
								</View>
							)}
						</View>

						{sheetState !== 'full' && (
							<Text style={styles.swipeHint}>Swipe up to view full details</Text>
						)}

						{sheetState === 'full' && (
							<>
								{activeProduct.description ? (
									<Text style={styles.description}>{activeProduct.description.trim()}</Text>
								) : (
									<Text style={[styles.description, { color: colors.textDim }]}>Add a description to tell buyers about fit, fabric and details.</Text>
								)}

								{meta.length > 0 && (
									<View style={styles.metaGrid}>
										{meta.map((item) => (
											<View key={item.label} style={styles.metaTile}>
												<Text style={styles.metaLabel}>{item.label}</Text>
												<Text style={styles.metaValue}>{item.value}</Text>
											</View>
										))}
									</View>
								)}

								{!!activeProduct.tags?.length && (
									<View style={styles.tagsRow}>
										{activeProduct.tags.map((tag) => (
											<View key={tag} style={styles.tag}>
												<Text style={styles.tagText}>{tag}</Text>
											</View>
										))}
									</View>
								)}
							</>
						)}
					</ScrollView>
					{sheetState === 'full' && (
							<View style={styles.bottomCtaWrap}>
								<View style={styles.bottomCtaRow}>
									<Pressable
										onPressIn={fireSelectionHaptic}
										onPress={handleTry}
										style={({ pressed }) => [
											styles.bottomBtn,
											styles.bottomSecondary,
											pressFeedback(pressed),
										]}
									>
										<Ionicons name="sparkles-outline" size={18} color={colors.text} />
										<Text style={styles.bottomSecondaryText}>Try now</Text>
									</Pressable>
									<Pressable
										onPressIn={fireSelectionHaptic}
										onPress={handleBuy}
										disabled={!isPurchasable}
										style={({ pressed }) => [
											styles.bottomBtn,
											styles.bottomPrimary,
											!isPurchasable && styles.disabledBtn,
											isPurchasable ? pressFeedback(pressed) : null,
										]}
									>
										<Text style={styles.bottomPrimaryText}>{buyButtonLabel}</Text>
									</Pressable>
								</View>
							</View>
					)}
				</BlurView>
			</Animated.View>
			{!!basketToast && (
				<Animated.View
					pointerEvents="box-none"
					style={[
						styles.basketToastWrap,
						{
							bottom: insets.bottom + (sheetState === 'full' ? 108 : 28),
							opacity: basketToastOpacity,
							transform: [{ translateY: basketToastTranslateY }],
						},
					]}
				>
					<Pressable onPress={() => setBasketToast(null)} style={styles.basketToastShell}>
						<BlurView intensity={42} tint="light" style={styles.basketToastBlur}>
							<View style={styles.basketToastCard}>
								<View style={styles.basketToastIconWrap}>
									<Ionicons name="checkmark-circle" size={16} color={colors.text} />
								</View>
								<View style={styles.basketToastTextWrap}>
									<Text numberOfLines={1} style={styles.basketToastTitle}>{basketToast.title}</Text>
									{!!basketToast.message && (
										<Text numberOfLines={2} style={styles.basketToastMessage}>{basketToast.message}</Text>
									)}
								</View>
								<Ionicons name="close" size={15} color={colors.textDim} />
							</View>
						</BlurView>
					</Pressable>
				</Animated.View>
			)}
		</Modal>
	);
}

function formatPrice(value?: string | null) {
	if (!value) return undefined;
	return toGBPPriceLabel(value) || undefined;
}

function parsePrice(value?: string | null) {
	if (!value) return 0;
	const numeric = Number(String(value).replace(/[^0-9.]/g, ''));
	if (!Number.isNaN(numeric) && Number.isFinite(numeric)) return numeric;
	return 0;
}

const styles = StyleSheet.create({
	sheet: {
		position: 'absolute',
		left: 0,
		right: 0,
		bottom: 0,
		height: SCREEN_HEIGHT,
	},
	glass: {
		flex: 1,
		borderTopLeftRadius: s(6),
		borderTopRightRadius: s(6),
		borderWidth: hairline,
		borderColor: colors.borderLight,
		overflow: 'hidden',
		backgroundColor: 'rgba(255,255,255,0.65)',
	},
	handleZone: {
		paddingTop: s(4),
		paddingBottom: s(2),
		alignItems: 'center',
	},
	handle: {
		width: 48,
		height: 5,
		borderRadius: 999,
		backgroundColor: 'rgba(0,0,0,0.18)',
	},
	content: {
		// keep bottom padding small so compact CTAs appear above the fold
		paddingBottom: s(6),
		paddingHorizontal: s(3),
	},
	heroComposite: {
		marginBottom: s(3),
		position: 'relative',
	},
	carouselWrap: {
		width: HERO_WIDTH,
		alignSelf: 'center',
	},
	carouselWrapRelative: {
		position: 'relative',
	},
	carousel: {
		width: HERO_WIDTH,
		alignSelf: 'center',
	},
	heroFrame: {
		width: HERO_WIDTH,
		alignItems: 'center',
		justifyContent: 'center',
	},
	heroImage: {
		width: '100%',
		height: HERO_HEIGHT,
		borderRadius: s(4),
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.4)',
	},
	heroErrorState: {
		width: '100%',
		height: HERO_HEIGHT,
		borderRadius: s(4),
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.45)',
		alignItems: 'center',
		justifyContent: 'center',
	},
	heroErrorText: {
		marginTop: 6,
		color: colors.textDim,
		fontWeight: '600',
	},
	emptyImage: {
		width: HERO_WIDTH,
		height: HERO_HEIGHT,
		borderRadius: s(4),
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.4)',
		alignItems: 'center',
		justifyContent: 'center',
		alignSelf: 'center',
	},
	emptyImageText: {
		marginTop: 6,
		color: colors.textDim,
		fontWeight: '600',
	},
	pagination: {
		position: 'absolute',
		bottom: s(1),
		left: 0,
		right: 0,
		width: HERO_WIDTH,
		alignSelf: 'center',
		flexDirection: 'row',
		justifyContent: 'center',
		gap: 6,
	},
	dot: {
		width: 6,
		height: 6,
		borderRadius: 3,
		backgroundColor: 'rgba(255,255,255,0.4)',
	},
	dotActive: {
		backgroundColor: colors.text,
	},
	titleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: s(2),
		marginBottom: s(1.5),
	},
	title: {
		...font.h2,
		marginBottom: 0,
		flex: 1,
	},
	basketRemoveChip: {
		height: 34,
		borderRadius: 17,
		paddingHorizontal: s(1.5),
		flexDirection: 'row',
		alignItems: 'center',
		gap: s(0.8),
		backgroundColor: 'rgba(229,57,53,0.10)',
		borderWidth: hairline,
		borderColor: 'rgba(229,57,53,0.26)',
	},
	basketRemoveChipText: {
		fontSize: 12,
		fontWeight: '700',
		color: colors.danger,
	},
	iconBtn: {
		width: 44,
		height: 44,
		borderRadius: 22,
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.9)',
		alignItems: 'center',
		justifyContent: 'center',
	},
	priceRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		marginBottom: s(2.5),
	},
	priceBlock: {
		flexDirection: 'row',
		alignItems: 'flex-end',
		gap: s(1),
		flexShrink: 1,
	},
	price: {
		fontSize: 24,
		fontWeight: '800',
		color: colors.text,
	},
	compareAt: {
		...font.meta,
		textDecorationLine: 'line-through',
	},
	swipeHint: {
		...font.meta,
		textAlign: 'center',
		color: colors.textDim,
		marginBottom: s(3),
	},
	description: {
		...font.p,
		color: colors.text,
		lineHeight: 20,
		marginBottom: s(3),
	},
	metaGrid: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: s(2),
		marginBottom: s(3),
	},
	metaTile: {
		flexBasis: '47%',
		backgroundColor: colors.pillBg,
		borderRadius: s(3),
		padding: s(2),
		borderWidth: hairline,
		borderColor: colors.borderLight,
	},
	metaLabel: {
		...font.meta,
		marginBottom: 4,
	},
	metaValue: {
		...font.p,
		fontWeight: '700',
	},
	tagsRow: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: s(1.5),
		marginBottom: s(4),
	},
	tag: {
		paddingHorizontal: s(2),
		paddingVertical: s(1),
		borderRadius: s(4),
		backgroundColor: colors.pillBg,
	},
	tagText: {
		...font.meta,
		color: colors.text,
	},
	bottomCtaWrap: {
		paddingHorizontal: s(3),
		paddingBottom: s(4),
		paddingTop: s(2),
		borderTopWidth: hairline,
		borderTopColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.82)',
	},
	bottomCtaRow: {
		flexDirection: 'row',
		gap: s(2),
	},
	bottomBtn: {
		flex: 1,
		height: 56,
		borderRadius: 30,
		alignItems: 'center',
		justifyContent: 'center',
		flexDirection: 'row',
		gap: 8,
	},
	bottomSecondary: {
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.92)',
	},
	bottomSecondaryText: {
		fontSize: 15,
		fontWeight: '700',
		color: colors.text,
		letterSpacing: 0.2,
	},
	bottomPrimary: {
		backgroundColor: colors.text,
		shadowColor: '#000',
		shadowOpacity: 0.18,
		shadowRadius: 10,
		shadowOffset: { width: 0, height: 5 },
	},
	bottomPrimaryText: {
		color: '#fff',
		fontSize: 16,
		fontWeight: '800',
		letterSpacing: 0.3,
	},
	/* New compact/like styles */
	titleBlock: {
		paddingHorizontal: s(1),
		paddingBottom: s(2),
	},
	titleBlockHalf: {
		paddingBottom: s(5.2),
	},
	sellerSection: {
		marginBottom: s(1.8),
		gap: s(0.8),
	},
	sellerEyebrow: {
		...font.meta,
		color: colors.textDim,
		fontWeight: '800',
		textTransform: 'uppercase',
		letterSpacing: 0.3,
	},
	sellerCard: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: s(1.2),
		borderRadius: 14,
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.9)',
		paddingHorizontal: s(1.4),
		paddingVertical: s(1.1),
	},
	sellerAvatarShell: {
		width: 30,
		height: 30,
		borderRadius: 15,
		overflow: 'hidden',
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.95)',
		alignItems: 'center',
		justifyContent: 'center',
	},
	sellerAvatar: {
		width: '100%',
		height: '100%',
	},
	sellerTextWrap: {
		flex: 1,
		gap: 1,
	},
	sellerDisplayName: {
		fontSize: 13,
		fontWeight: '700',
		color: colors.text,
	},
	sellerUsername: {
		...font.meta,
		color: colors.textDim,
		fontSize: 11,
	},
	likePill: {
		minWidth: 64,
		height: 40,
		borderRadius: 20,
		alignItems: 'center',
		justifyContent: 'center',
		flexDirection: 'row',
		gap: s(0.8),
		paddingHorizontal: s(1.4),
		backgroundColor: 'rgba(255,255,255,0.94)',
		borderWidth: hairline,
		borderColor: colors.borderLight,
		shadowColor: '#000',
		shadowOpacity: 0.06,
		shadowRadius: 6,
		shadowOffset: { width: 0, height: 3 },
	},
	likeCountText: {
		fontSize: 12,
		fontWeight: '700',
		color: colors.text,
		minWidth: 24,
		textAlign: 'left',
	},
	likePillAbsolute: {
		position: 'absolute',
		top: s(6),
		right: s(6),
		zIndex: 30,
	},
	compactCtaRow: {
		flexDirection: 'row',
		gap: s(2),
		paddingHorizontal: s(1),
		marginTop: s(1),
		marginBottom: s(1),
	},
	compactCtaRowHalf: {
		marginTop: s(-0.2),
		marginBottom: s(4.1),
		transform: [{ translateY: -s(2.2) }],
	},
	compactBtn: {
		flex: 1,
		height: 48,
		borderRadius: 24,
		alignItems: 'center',
		justifyContent: 'center',
		flexDirection: 'row',
		gap: 8,
	},
	compactSecondary: {
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.92)',
	},
	compactSecondaryText: {
		fontSize: 14,
		fontWeight: '700',
		color: colors.text,
	},
	compactPrimary: {
		backgroundColor: colors.text,
		shadowColor: '#000',
		shadowOpacity: 0.12,
		shadowRadius: 8,
		shadowOffset: { width: 0, height: 4 },
	},
	compactPrimaryText: {
		color: '#fff',
		fontSize: 15,
		fontWeight: '800',
	},
	basketToastWrap: {
		position: 'absolute',
		left: s(3),
		right: s(3),
		alignItems: 'center',
		zIndex: 120,
	},
	basketToastShell: {
		width: '100%',
		maxWidth: 520,
		borderRadius: 16,
		overflow: 'hidden',
	},
	basketToastBlur: {
		borderRadius: 16,
		overflow: 'hidden',
	},
	basketToastCard: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: s(1.6),
		paddingHorizontal: s(2.2),
		paddingVertical: s(1.9),
		borderRadius: 16,
		borderWidth: hairline,
		borderColor: colors.borderLight,
		backgroundColor: 'rgba(255,255,255,0.84)',
	},
	basketToastIconWrap: {
		width: 24,
		height: 24,
		borderRadius: 12,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(255,255,255,0.9)',
	},
	basketToastTextWrap: {
		flex: 1,
		minWidth: 0,
	},
	basketToastTitle: {
		fontSize: 12,
		fontWeight: '800',
		color: colors.text,
	},
	basketToastMessage: {
		marginTop: 2,
		fontSize: 11,
		fontWeight: '600',
		lineHeight: 15,
		color: colors.textDim,
	},
	disabledBtn: {
		opacity: 0.58,
	},
});
