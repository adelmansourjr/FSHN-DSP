import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, Alert, ActivityIndicator } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { s, font, hairline } from '../theme/tokens';
import { useCart } from '../context/CartContext';
import MinimalHeader from '../components/MinimalHeader';
import ProductModal, { ProductLike } from '../components/ProductModal';
import { Image as ExpoImage } from 'expo-image';
import { useTheme } from '../theme/ThemeContext';
import { pressFeedback } from '../theme/pressFeedback';
import { isExpoGo, useStripeSafe } from '../lib/payments/stripeNative';
import { useAppStatus } from '../context/AppStatusContext';
import {
  createPaymentIntent,
  finalizePaymentIntent,
  quoteShipping,
  resolveBackendUrl,
} from '../lib/payments/stripe';
import { buildJsonHeaders } from '../lib/apiAuth';
import { useAuth } from '../context/AuthContext';
import { toGBPPriceLabel } from '../lib/currency';
import {
  isShippingAddressComplete,
  sanitizeShippingAddress,
} from '../lib/shippingAddress';
import { useListingLikes } from '../lib/listingLikes';
import type { ShippingQuoteResponse } from '../lib/shippingCo';

function BasketItemRow({
  item,
  shippingLabel,
  shippingToneLabel,
  selected,
  onPress,
  onToggleSelect,
  onRemove,
  styles,
  colors,
  textDim,
}: {
  item: any;
  shippingLabel?: string | null;
  shippingToneLabel?: string | null;
  selected: boolean;
  onPress: () => void;
  onToggleSelect: () => void;
  onRemove: () => void;
  styles: {
    row: any;
    rowSelected: any;
    thumb: any;
    checkboxBtn: any;
    removeBtn: any;
    removeText: any;
  };
  colors: {
    text: string;
    textDim: string;
  };
  textDim: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressFeedback(pressed, 'subtle'),
      ]}
    >
      <Pressable
        onPress={(event) => {
          event.stopPropagation();
          onToggleSelect();
        }}
        style={({ pressed }) => [styles.checkboxBtn, pressFeedback(pressed, 'subtle')]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={selected ? 'Deselect item' : 'Select item'}
      >
        <Ionicons
          name={selected ? 'checkmark-circle' : 'ellipse-outline'}
          size={22}
          color={selected ? colors.text : colors.textDim}
        />
      </Pressable>
      {item.uri ? (
        <ExpoImage source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" cachePolicy="memory-disk" transition={120} />
      ) : (
        <View style={styles.thumb} />
      )}
      <View style={{ flex: 1, marginLeft: s(3) }}>
        <Text style={[font.h3, { fontSize: 15 }]} numberOfLines={1}>{item.title}</Text>
        <Text style={{ color: textDim, marginTop: s(0.5) }}>
          {toGBPPriceLabel(Number(item.price || 0).toFixed(2))} · Qty {item.qty || 1}
        </Text>
        {!!shippingLabel && (
          <Text style={{ color: textDim, marginTop: s(0.35), fontSize: 12 }}>
            {shippingToneLabel ? `${shippingToneLabel} · ` : ''}
            {shippingLabel}
          </Text>
        )}
      </View>
      <Pressable
        onPress={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        style={({ pressed }) => [styles.removeBtn, pressFeedback(pressed, 'subtle')]}
        accessibilityRole="button"
        accessibilityLabel="Remove item"
      >
        <Text style={styles.removeText}>Remove</Text>
      </Pressable>
    </Pressable>
  );
}

function extractListingId(item: any): string {
  const explicit = String(item?.listingId || item?.product?.listingId || '').trim();
  if (explicit) return explicit;

  const productId = String(item?.product?.id || '').trim();
  if (productId.startsWith('listing:')) return productId.slice('listing:'.length);
  if (productId.startsWith('real-listing-')) return productId.slice('real-listing-'.length);

  const rawId = String(item?.id || '').trim();
  if (!rawId) return '';
  if (rawId.startsWith('listing:')) return rawId.slice('listing:'.length);
  if (rawId.startsWith('real-listing-')) return rawId.slice('real-listing-'.length);
  return '';
}

function toCheckoutItems(items: any[]) {
  return items.map((item) => {
    const qty = Math.max(1, Number(item?.qty) || 1);
    const price = Number(item?.price) || 0;
    const listingId = extractListingId(item);
    return {
      id: String(item?.id || listingId || item?.title || '').trim(),
      listingId: listingId || undefined,
      title: String(item?.title || 'Item'),
      qty,
      price,
      unitAmount: Math.max(0, Math.round(price * 100)),
      imageUrl: String(item?.uri || item?.product?.image || '').trim() || undefined,
    };
  });
}

function parseUnavailableListingIds(errorLike: unknown): string[] {
  const raw = String((errorLike as any)?.message || errorLike || '').trim();
  if (!raw) return [];

  let payload: any = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  const details =
    String(payload?.details || '').trim() ||
    (raw.startsWith('unavailable-listings:') ? raw.slice('unavailable-listings:'.length) : '');

  if (!details) return [];
  return details
    .split(',')
    .map((entry) => String(entry || '').trim())
    .map((entry) => entry.split(':')[0]?.trim() || '')
    .filter(Boolean);
}

export default function BasketScreen({ onClose }: { onClose?: () => void }) {
  const insets = useSafeAreaInsets();
  const {
    items,
    selectedIds,
    clear,
    remove,
    removeMany,
    isSelected,
    toggleSelected,
    selectAll,
    clearSelection,
  } = useCart();
  const { user, profile } = useAuth();
  const { isLiked: isListingLiked, setLiked: setListingLiked } = useListingLikes(user?.uid);
  const { reportError } = useAppStatus();
  const { colors, isDark } = useTheme();
  const { initPaymentSheet, presentPaymentSheet } = useStripeSafe();
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [shippingQuote, setShippingQuote] = useState<ShippingQuoteResponse | null>(null);
  const [shippingQuoteLoading, setShippingQuoteLoading] = useState(false);
  const [shippingQuoteError, setShippingQuoteError] = useState<string | null>(null);
  const [activeProduct, setActiveProduct] = useState<ProductLike | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedItems = useMemo(
    () => items.filter((item) => selectedIdSet.has(item.id)),
    [items, selectedIdSet]
  );

  const totalCount = useMemo(
    () => items.reduce((sum, it) => sum + (it.qty || 1), 0),
    [items]
  );
  const selectedCount = useMemo(
    () => selectedItems.reduce((sum, it) => sum + (it.qty || 1), 0),
    [selectedItems]
  );
  const selectedTotal = useMemo(
    () => selectedItems.reduce((sum, it) => sum + (it.price || 0) * (it.qty || 1), 0),
    [selectedItems]
  );
  const selectedCheckoutItems = useMemo(() => toCheckoutItems(selectedItems), [selectedItems]);
  const shippingAddress = useMemo(
    () => sanitizeShippingAddress(profile?.shippingAddress || {}),
    [profile?.shippingAddress]
  );
  const hasListingItems = useMemo(
    () => selectedCheckoutItems.some((it) => Boolean(it.listingId)),
    [selectedCheckoutItems]
  );
  const shippingQuoteByListingId = useMemo(() => {
    const next: Record<string, ShippingQuoteResponse['items'][number]> = {};
    (shippingQuote?.items || []).forEach((entry) => {
      if (!entry?.listingId) return;
      next[entry.listingId] = entry;
    });
    return next;
  }, [shippingQuote?.items]);
  const shippingAmount = Number(shippingQuote?.shippingAmount || 0);
  const subtotalAmount =
    typeof shippingQuote?.subtotalAmount === 'number'
      ? Math.max(0, shippingQuote.subtotalAmount) / 100
      : selectedTotal;
  const displayTotal = subtotalAmount + shippingAmount / 100;
  const allSelected = items.length > 0 && selectedItems.length === items.length;
  const dockClearance = 28 + 64;

  useEffect(() => {
    let cancelled = false;

    if (!selectedItems.length || !hasListingItems || !user?.uid) {
      setShippingQuote(null);
      setShippingQuoteError(null);
      setShippingQuoteLoading(false);
      return () => {
        cancelled = true;
      };
    }

    if (!isShippingAddressComplete(shippingAddress)) {
      setShippingQuote(null);
      setShippingQuoteError('Add your delivery address in Settings to calculate ShippingCo shipping.');
      setShippingQuoteLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setShippingQuoteLoading(true);
    setShippingQuoteError(null);

    void quoteShipping({
      shippingAddress,
      items: selectedCheckoutItems,
    })
      .then((nextQuote) => {
        if (cancelled) return;
        setShippingQuote(nextQuote);
      })
      .catch((error: any) => {
        if (cancelled) return;
        setShippingQuote(null);
        setShippingQuoteError(error?.message || 'Could not quote ShippingCo shipping right now.');
      })
      .finally(() => {
        if (cancelled) return;
        setShippingQuoteLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasListingItems, selectedCheckoutItems, selectedItems.length, shippingAddress, user?.uid]);

  const openItem = (item: any) => {
    if (!item?.product) return;
    setActiveProduct(item.product as ProductLike);
    setModalOpen(true);
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: s(2.4),
          paddingHorizontal: s(2.4),
          borderRadius: 18,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.82)',
        },
        rowSelected: {
          backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.96)',
        },
        thumb: {
          width: 72,
          height: 72,
          borderRadius: 12,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)',
        },
        checkboxBtn: {
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: s(1.6),
        },
        listHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: s(2),
          marginBottom: s(2.5),
        },
        selectionBtn: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(1),
          paddingHorizontal: s(2),
          paddingVertical: s(1.3),
          borderRadius: 999,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.9)',
        },
        selectionBtnTxt: {
          fontSize: 12,
          fontWeight: '800',
          color: colors.text,
        },
        selectionMeta: {
          fontSize: 12,
          fontWeight: '700',
          color: colors.textDim,
        },
        footer: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: s(2),
          paddingTop: s(3),
          paddingHorizontal: s(4),
          borderTopWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: colors.bg,
        },
        checkoutBtn: {
          backgroundColor: colors.text,
          paddingVertical: s(3),
          paddingHorizontal: s(6),
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: s(28),
        },
        removeBtn: {
          paddingHorizontal: s(2),
          paddingVertical: s(1.2),
          borderRadius: 999,
          borderWidth: hairline,
          borderColor: colors.borderLight,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.85)',
        },
        removeText: { fontSize: 11, fontWeight: '700', color: colors.textDim },
      }),
    [colors, isDark]
  );

  const handleCheckout = async () => {
    if (checkoutBusy || selectedItems.length === 0) return;
    try {
      const nonPurchasableIds = selectedItems
        .filter((item) => !extractListingId(item))
        .map((item) => item.id);
      if (nonPurchasableIds.length) {
        removeMany(nonPurchasableIds);
        Alert.alert(
          'Removed from basket',
          'Closet items are not purchasable and were removed from your basket.'
        );
        return;
      }

      const checkoutItems = selectedCheckoutItems;
      const checkedOutItemIds = checkoutItems.map((it) => it.id).filter(Boolean);
      const buyerUid = user?.uid || '';

      if (hasListingItems && !buyerUid) {
        Alert.alert('Sign in required', 'Please sign in to complete checkout so purchases are saved to your account.');
        return;
      }
      if (hasListingItems && !isShippingAddressComplete(shippingAddress)) {
        Alert.alert(
          'Delivery address required',
          'Add your delivery address in Settings before purchasing marketplace listings.'
        );
        return;
      }
      if (hasListingItems && shippingQuoteLoading) {
        Alert.alert('Shipping quote pending', 'Please wait while ShippingCo shipping is calculated.');
        return;
      }
      if (hasListingItems && !shippingQuote) {
        Alert.alert(
          'Shipping unavailable',
          shippingQuoteError || 'Could not calculate ShippingCo shipping for this basket.'
        );
        return;
      }
      if (__DEV__) {
        console.log('[Checkout] start', {
          items: selectedItems.length,
          total: displayTotal,
          isExpoGo,
          listingItems: checkoutItems.filter((it) => !!it.listingId).length,
        });
      }

      if (isExpoGo) {
        const backendUrl = resolveBackendUrl();
        if (!backendUrl) {
          Alert.alert('Checkout error', 'Stripe backend URL is missing.');
          return;
        }

        setCheckoutBusy(true);
        if (__DEV__) {
          console.log('[Checkout] create checkout session', { backendUrl });
        }
        const res = await fetch(`${backendUrl}/create-checkout-session`, {
          method: 'POST',
          headers: await buildJsonHeaders({ required: true }),
          body: JSON.stringify({
            shippingAddress,
            items: checkoutItems,
          }),
        });

        if (!res.ok) {
          const msg = await res.text();
          let parsedMessage = msg || 'Failed to create checkout session';
          try {
            const parsed = JSON.parse(msg);
            if (parsed?.error) {
              parsedMessage = parsed.details ? `${parsed.error} (${parsed.details})` : parsed.error;
            }
          } catch {
            // keep raw message
          }
          throw new Error(parsedMessage);
        }

        const data = await res.json();
        if (!data?.url) {
          throw new Error('Missing checkout URL');
        }

        await WebBrowser.openBrowserAsync(data.url);
        return;
      }

      setCheckoutBusy(true);
      const amountCents = Math.round(displayTotal * 100);
      if (__DEV__) {
        console.log('[Checkout] creating payment intent', { amountCents });
      }
      const { clientSecret, paymentIntentId } = await createPaymentIntent({
        amount: amountCents,
        currency: 'gbp',
        shippingAddress,
        items: checkoutItems,
      });
      if (__DEV__) {
        console.log('[Checkout] payment intent created', {
          hasClientSecret: !!clientSecret,
          paymentIntentId,
        });
      }

      if (__DEV__) {
        console.log('[Checkout] init payment sheet');
      }
      const init = await initPaymentSheet({
        paymentIntentClientSecret: clientSecret,
        merchantDisplayName: 'FSHN',
        allowsDelayedPaymentMethods: false,
      });

      if (init.error) {
        console.warn('[Checkout] init payment sheet error', init.error);
        Alert.alert('Payment setup failed', init.error.message || 'Please try again.');
        return;
      }

      if (__DEV__) {
        console.log('[Checkout] present payment sheet');
      }
      const result = await presentPaymentSheet();
      if (result.error) {
        console.warn('[Checkout] payment cancelled/error', result.error);
        Alert.alert('Payment cancelled', result.error.message || 'No charges were made.');
        return;
      }

      if (__DEV__) {
        console.log('[Checkout] success');
      }
      let finalizeFailed = false;
      if (paymentIntentId) {
        let finalized = false;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const finalizeResult = await finalizePaymentIntent({
              paymentIntentId,
              shippingAddress,
              items: checkoutItems,
            });
            if (__DEV__) {
              console.log('[Checkout] finalize result', { attempt, finalizeResult });
            }
            finalized = true;
            break;
          } catch (finalizeErr: any) {
            console.warn('[Checkout] finalize failed', { attempt, finalizeErr });
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, attempt * 450));
            }
          }
        }
        finalizeFailed = !finalized;
      } else {
        console.warn('[Checkout] missing paymentIntentId; skipping finalize call');
        finalizeFailed = true;
      }

      if (finalizeFailed) {
        Alert.alert(
          'Payment captured',
          'Your payment succeeded, but order sync failed. Please reopen the basket and retry checkout sync.'
        );
        return;
      }

      if (checkedOutItemIds.length) {
        removeMany(checkedOutItemIds);
      } else {
        clear();
      }
      Alert.alert('Payment complete', 'Order placed (sandbox).');
      onClose?.();
    } catch (err: any) {
      if (__DEV__) {
        console.error('[Checkout] error', err);
      }
      const unavailableListingIds = parseUnavailableListingIds(err);
      if (unavailableListingIds.length) {
        const idsToRemove = selectedItems
          .filter((item) => unavailableListingIds.includes(extractListingId(item)))
          .map((item) => item.id);
        if (idsToRemove.length) {
          removeMany(idsToRemove);
        }
        Alert.alert(
          'Item unavailable',
          'One or more listings are no longer available and were removed from your basket.'
        );
        return;
      }
      reportError(err, {
        key: 'basket.checkout.network',
        fallbackTitle: 'Checkout unavailable',
        fallbackMessage: 'Could not reach payment services. Please try again shortly.',
      });
      Alert.alert('Checkout error', err?.message || 'Please try again.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const checkoutDisabled =
    checkoutBusy ||
    shippingQuoteLoading ||
    selectedItems.length === 0 ||
    (hasListingItems && (!shippingQuote || !!shippingQuoteError));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MinimalHeader title="Basket" onRightPress={onClose} rightIcon="close" rightA11yLabel="Close basket" />
      <View style={{ flex: 1, padding: s(4) }}>
        {items.length === 0 ? (
          <View style={{ alignItems: 'center', marginTop: s(8) }}>
            <Text style={[font.h3, { color: colors.text }]}>Your basket is empty</Text>
            <Text style={{ color: colors.textDim, marginTop: s(2) }}>Add items from product pages to build an order.</Text>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(i) => i.id}
            contentContainerStyle={{ paddingBottom: s(2) }}
            ListHeaderComponent={
              items.length > 1 ? (
                <View style={styles.listHeader}>
                  <Pressable
                    onPress={allSelected ? clearSelection : selectAll}
                    style={({ pressed }) => [styles.selectionBtn, pressFeedback(pressed, 'subtle')]}
                  >
                    <Ionicons
                      name={allSelected ? 'checkmark-circle' : 'ellipse-outline'}
                      size={16}
                      color={colors.text}
                    />
                    <Text style={styles.selectionBtnTxt}>
                      {allSelected ? 'Clear selection' : 'Select all'}
                    </Text>
                  </Pressable>
                  <Text style={styles.selectionMeta}>
                    {selectedItems.length} of {items.length} selected
                  </Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <BasketItemRow
                item={item}
                shippingLabel={(() => {
                  const listingId = extractListingId(item);
                  const quote = listingId ? shippingQuoteByListingId[listingId] : null;
                  return quote ? toGBPPriceLabel((quote.amount / 100).toFixed(2)) : null;
                })()}
                shippingToneLabel={(() => {
                  const listingId = extractListingId(item);
                  const quote = listingId ? shippingQuoteByListingId[listingId] : null;
                  if (!quote) return null;
                  return 'ShippingCo';
                })()}
                selected={isSelected(item.id)}
                onPress={() => openItem(item)}
                onToggleSelect={() => toggleSelected(item.id)}
                onRemove={() => remove(item.id)}
                styles={styles}
                colors={{ text: colors.text, textDim: colors.textDim }}
                textDim={colors.textDim}
              />
            )}
            ItemSeparatorComponent={() => <View style={{ height: s(2) }} />}
          />
        )}
      </View>

      <View
        style={[
          styles.footer,
          { paddingBottom: Math.max(insets.bottom, s(4)) + dockClearance },
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.textDim }}>
            Selected · {selectedCount} of {totalCount} item{totalCount === 1 ? '' : 's'}
          </Text>
          <View style={{ marginTop: s(0.8), gap: s(0.45) }}>
            <Text style={{ color: colors.textDim }}>
              Subtotal · {toGBPPriceLabel(subtotalAmount.toFixed(2))}
            </Text>
            <Text style={{ color: colors.textDim }}>
              Shipping · {shippingQuoteLoading ? 'Calculating…' : toGBPPriceLabel((shippingAmount / 100).toFixed(2)) || '£0.00'}
            </Text>
            <Text style={[font.h2]}>
              {toGBPPriceLabel(displayTotal.toFixed(2))}
            </Text>
            {!!shippingQuoteError && (
              <Text style={{ color: '#bf2d2d', fontSize: 12 }}>
                {shippingQuoteError}
              </Text>
            )}
          </View>
        </View>
        <Pressable
          onPress={handleCheckout}
          disabled={checkoutDisabled}
          style={({ pressed }) => [
            styles.checkoutBtn,
            checkoutDisabled && { opacity: 0.6 },
            !checkoutDisabled && pressFeedback(pressed, 'strong'),
          ]}
          accessibilityRole="button"
        >
          {checkoutBusy ? (
            <ActivityIndicator color={isDark ? colors.bg : '#fff'} />
          ) : (
            <Text style={{ color: isDark ? colors.bg : '#fff', fontWeight: '800' }}>
              Buy now
            </Text>
          )}
        </Pressable>
      </View>

      <ProductModal
        visible={modalOpen}
        product={activeProduct ?? undefined}
        onClose={() => setModalOpen(false)}
        initialLiked={isListingLiked(activeProduct?.id, activeProduct?.listingId)}
        onLikeChange={(liked, product) => {
          if (product?.id) setListingLiked(product.id, liked, product.listingId);
        }}
      />
    </View>
  );
}
