import { deleteField, doc, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { resolveBackendUrl } from './payments/stripe';
import { auth, db } from './firebase';

export type OrderStatus =
  | 'paid'
  | 'pending_delivery'
  | 'shipped'
  | 'out_for_delivery'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'cancelled_by_buyer'
  | 'cancelled_by_seller';

export type OrderActorRole = 'buyer' | 'seller';

type NextOrderAction = {
  nextStatus: OrderStatus;
  label: string;
  timestampField: 'shippedAt' | 'outForDeliveryAt' | 'deliveredAt' | 'completedAt';
};

type CancelOrderAction = {
  nextStatus: OrderStatus;
  label: string;
  confirmTitle: string;
  confirmMessage: string;
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  paid: 'Pending delivery',
  pending_delivery: 'Pending delivery',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  cancelled_by_buyer: 'Cancelled',
  cancelled_by_seller: 'Cancelled',
};

const STATUS_DESCRIPTIONS: Record<OrderStatus, string> = {
  paid: 'Purchased and waiting for the seller to dispatch it.',
  pending_delivery: 'Purchased and waiting for the seller to dispatch it.',
  shipped: 'The seller marked this order as shipped.',
  out_for_delivery: 'The order is out for delivery.',
  delivered: 'The order has been delivered to the buyer.',
  completed: 'The order lifecycle is complete.',
  cancelled: 'This order was cancelled before shipment.',
  cancelled_by_buyer: 'This order was cancelled by the buyer before shipment.',
  cancelled_by_seller: 'This order was cancelled by the seller before shipment.',
};

const NEXT_ACTIONS: Record<'paid' | 'pending_delivery' | 'shipped' | 'out_for_delivery' | 'delivered', NextOrderAction> = {
  paid: {
    nextStatus: 'shipped',
    label: 'Mark shipped',
    timestampField: 'shippedAt',
  },
  pending_delivery: {
    nextStatus: 'shipped',
    label: 'Mark shipped',
    timestampField: 'shippedAt',
  },
  shipped: {
    nextStatus: 'out_for_delivery',
    label: 'Out for delivery',
    timestampField: 'outForDeliveryAt',
  },
  out_for_delivery: {
    nextStatus: 'delivered',
    label: 'Mark delivered',
    timestampField: 'deliveredAt',
  },
  delivered: {
    nextStatus: 'completed',
    label: 'Complete order',
    timestampField: 'completedAt',
  },
};

const CANCELLABLE_STATUSES = new Set<OrderStatus>(['paid', 'pending_delivery']);

const cleanString = (value: unknown) => String(value || '').trim().toLowerCase();

const hasTimestampValue = (value: any) => {
  if (!value) return false;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime());
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'object') {
    if (typeof value.seconds === 'number' || typeof value.nanoseconds === 'number') return true;
  }
  return false;
};

const hasShipmentProgress = (raw?: any) =>
  hasTimestampValue(raw?.shippedAt) ||
  hasTimestampValue(raw?.outForDeliveryAt) ||
  hasTimestampValue(raw?.deliveredAt) ||
  hasTimestampValue(raw?.completedAt);

const makeShortDisplayCode = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const compact = (hash >>> 0).toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.slice(-6).padStart(6, '0');
};

export const normalizeOrderStatus = (value?: string | null): OrderStatus => {
  const raw = cleanString(value);
  if (!raw) return 'paid';
  if (raw === 'paid' || raw === 'pending_delivery') return raw as OrderStatus;
  if (raw === 'shipped') return 'shipped';
  if (raw === 'out_for_delivery' || raw === 'out-for-delivery') return 'out_for_delivery';
  if (raw === 'delivered') return 'delivered';
  if (raw === 'completed' || raw === 'complete') return 'completed';
  if (raw === 'cancelled' || raw === 'canceled') return 'cancelled';
  if (raw === 'cancelled_by_buyer' || raw === 'canceled_by_buyer') return 'cancelled_by_buyer';
  if (raw === 'cancelled_by_seller' || raw === 'canceled_by_seller') return 'cancelled_by_seller';
  return 'paid';
};

export const formatOrderStatusLabel = (value?: string | null) => {
  const normalized = normalizeOrderStatus(value);
  return STATUS_LABELS[normalized];
};

export const describeOrderStatus = (value?: string | null) => {
  const normalized = normalizeOrderStatus(value);
  return STATUS_DESCRIPTIONS[normalized];
};

export const getNextSellerOrderAction = (value?: string | null): NextOrderAction | null => {
  const normalized = normalizeOrderStatus(value);
  if (!Object.prototype.hasOwnProperty.call(NEXT_ACTIONS, normalized)) return null;
  return NEXT_ACTIONS[normalized as keyof typeof NEXT_ACTIONS] || null;
};

export const getOrderCancellationAction = (
  value?: string | null,
  role: OrderActorRole = 'buyer',
  raw?: any
): CancelOrderAction | null => {
  const normalized = normalizeOrderStatus(value);
  if (!CANCELLABLE_STATUSES.has(normalized) || hasShipmentProgress(raw)) return null;

  if (role === 'seller') {
    return {
      nextStatus: 'cancelled_by_seller',
      label: 'Cancel order',
      confirmTitle: 'Cancel sold order?',
      confirmMessage:
        'This will cancel the order before shipment and return the listing to active.',
    };
  }

  return {
    nextStatus: 'cancelled_by_buyer',
    label: 'Cancel order',
    confirmTitle: 'Cancel bought order?',
    confirmMessage:
      'This will cancel the order before shipment and return the listing to active.',
  };
};

export const formatOrderNumber = (orderId?: string | null) => {
  const raw = String(orderId || '').trim();
  if (!raw) return 'Unavailable';
  const base = raw.split('__')[0] || raw;
  return `#${makeShortDisplayCode(base)}`;
};

export async function updateOrderStatus(orderId: string, nextStatus: OrderStatus) {
  const cleanId = String(orderId || '').trim();
  if (!cleanId) throw new Error('missing-order-id');
  const action = getNextSellerOrderAction(nextStatus);
  const payload: Record<string, any> = {
    status: nextStatus,
    updatedAt: serverTimestamp(),
  };
  if (nextStatus === 'shipped') payload.shippedAt = serverTimestamp();
  if (nextStatus === 'out_for_delivery') payload.outForDeliveryAt = serverTimestamp();
  if (nextStatus === 'delivered') payload.deliveredAt = serverTimestamp();
  if (nextStatus === 'completed') payload.completedAt = serverTimestamp();
  await updateDoc(doc(db, 'orders', cleanId), payload);
  return action;
}

async function cancelOrderClientSide(input: {
  orderId: string;
  actorUid: string;
  role: OrderActorRole;
}) {
  const cleanOrderId = String(input.orderId || '').trim();
  const cleanActorUid = String(input.actorUid || '').trim();
  if (!cleanOrderId) throw new Error('missing-order-id');
  if (!cleanActorUid) throw new Error('missing-actor-uid');

  const orderRef = doc(db, 'orders', cleanOrderId);

  await runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) {
      const error = new Error('ORDER_NOT_FOUND');
      (error as any).code = 'ORDER_NOT_FOUND';
      throw error;
    }

    const data = orderSnap.data() || {};
    const currentStatus = normalizeOrderStatus(String(data?.status || '').trim());
    const cancelAction = getOrderCancellationAction(currentStatus, input.role, data);
    if (!cancelAction) {
      const error = new Error('ORDER_NOT_CANCELLABLE');
      (error as any).code = 'ORDER_NOT_CANCELLABLE';
      throw error;
    }

    const buyerUid = String(data?.buyerUid || '').trim();
    const sellerUid = String(data?.sellerUid || '').trim();
    if (input.role === 'buyer' && buyerUid && buyerUid !== cleanActorUid) {
      const error = new Error('ORDER_ROLE_MISMATCH');
      (error as any).code = 'ORDER_ROLE_MISMATCH';
      throw error;
    }
    if (input.role === 'seller' && sellerUid && sellerUid !== cleanActorUid) {
      const error = new Error('ORDER_ROLE_MISMATCH');
      (error as any).code = 'ORDER_ROLE_MISMATCH';
      throw error;
    }

    const now = serverTimestamp();
    tx.update(orderRef, {
      status: cancelAction.nextStatus,
      cancelledAt: now,
      cancelledBy: input.role,
      cancelledByUid: cleanActorUid,
      updatedAt: now,
    });

    const listingId = String(
      data?.listingId || data?.listing?.id || data?.items?.[0]?.listingId || ''
    ).trim();
    if (!listingId) return;

    const listingRef = doc(db, 'listings', listingId);
    const listingSnap = await tx.get(listingRef);
    if (!listingSnap.exists()) return;

    const listing = listingSnap.data() || {};
    const listingStatus = String(listing?.status || '').trim().toLowerCase();
    const listingSoldToUid = String(listing?.soldToUid || '').trim();
    const listingSellerUid = String(listing?.sellerUid || '').trim();
    const buyerMatches = !buyerUid || !listingSoldToUid || listingSoldToUid === buyerUid;
    const sellerMatches = !sellerUid || !listingSellerUid || listingSellerUid === sellerUid;

    if (listingStatus !== 'sold' || !buyerMatches || !sellerMatches) return;

    tx.update(listingRef, {
      status: 'active',
      updatedAt: now,
      soldAt: deleteField(),
      soldToUid: deleteField(),
      soldPaymentRef: deleteField(),
      soldSource: deleteField(),
    });
  });
}

async function cancelOrderViaBackend(input: {
  orderId: string;
  actorUid: string;
  role: OrderActorRole;
}) {
  return postOrdersBackend('/cancel-order', {
    orderId: input.orderId,
    role: input.role,
  });
}

async function postOrdersBackend(path: string, body: Record<string, any>) {
  const backendUrl = resolveBackendUrl();
  if (!backendUrl) {
    const error = new Error('BACKEND_UNAVAILABLE');
    (error as any).code = 'BACKEND_UNAVAILABLE';
    throw error;
  }

  const currentUser = auth.currentUser;
  const idToken = currentUser ? await currentUser.getIdToken() : '';
  if (!idToken) {
    const error = new Error('MISSING_AUTH_TOKEN');
    (error as any).code = 'MISSING_AUTH_TOKEN';
    throw error;
  }

  let res: Response;
  try {
    res = await fetch(`${backendUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error: any) {
    const nextError = error instanceof Error ? error : new Error('CANCEL_REQUEST_FAILED');
    (nextError as any).code = 'BACKEND_UNAVAILABLE';
    throw nextError;
  }

  if (res.status === 404) {
    const error = new Error('BACKEND_ROUTE_MISSING');
    (error as any).code = 'BACKEND_ROUTE_MISSING';
    throw error;
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const json = await res.json();
      message = String(json?.error || json?.details || message);
    } catch {
      const text = await res.text().catch(() => '');
      if (text) message = text;
    }
    const error = new Error(message);
    (error as any).code = `HTTP_${res.status}`;
    throw error;
  }

  return res.json();
}

export async function createShippingCoSandboxShipment(orderId: string) {
  return postOrdersBackend('/shipping/sandbox/shippingco/create', {
    orderId,
  });
}

export async function advanceShippingCoSandboxShipment(orderId: string) {
  return postOrdersBackend('/shipping/sandbox/shippingco/advance', {
    orderId,
  });
}

export async function reconcileShippingCoSandboxShipments(orderIds: string[]) {
  const cleanIds = Array.from(
    new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
  if (!cleanIds.length) return null;
  return postOrdersBackend('/shipping/sandbox/shippingco/reconcile', {
    orderIds: cleanIds,
  });
}

export async function cancelOrder(input: {
  orderId: string;
  actorUid: string;
  role: OrderActorRole;
}) {
  try {
    await cancelOrderViaBackend({
      orderId: input.orderId,
      actorUid: input.actorUid,
      role: input.role,
    });
    return;
  } catch (error: any) {
    const code = String(error?.code || '');
    if (code !== 'BACKEND_UNAVAILABLE' && code !== 'BACKEND_ROUTE_MISSING' && code !== 'MISSING_AUTH_TOKEN') {
      throw error;
    }
  }

  await cancelOrderClientSide(input);
}
