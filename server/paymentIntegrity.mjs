function defaultCleanString(value, maxLen = 200) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLen);
}

export function orderDocId(paymentRef, listingId) {
  return `${paymentRef}__${listingId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
}

export function validateFulfillmentOpportunity({
  orderExists = false,
  listingExists = false,
  listingStatus = '',
  sellerUid = '',
  cleanString = defaultCleanString,
}) {
  if (orderExists) {
    return {
      duplicate: true,
      sellerUid: cleanString(sellerUid || '', 128) || null,
      reason: 'order-already-exists',
    };
  }

  if (!listingExists) {
    throw new Error('listing-not-found');
  }

  const status = cleanString(listingStatus || '', 40).toLowerCase();
  if (status === 'sold') {
    throw new Error('listing-already-sold');
  }
  if (status && !['active', 'live', 'published'].includes(status)) {
    throw new Error(`listing-unavailable:${status}`);
  }

  const cleanSellerUid = cleanString(sellerUid || '', 128);
  if (!cleanSellerUid) {
    throw new Error('missing-seller-uid');
  }

  return {
    duplicate: false,
    sellerUid: cleanSellerUid,
    reason: null,
  };
}

export function buildCheckoutFulfillmentContext({
  session,
  parseItemsFromMetadata,
  parseQuoteIdFromMetadata,
  parseShippingFromMetadata,
  cleanString = defaultCleanString,
}) {
  const safeSession = session || {};
  return {
    buyerUid:
      cleanString(safeSession?.metadata?.buyerUid || '', 128) ||
      cleanString(safeSession?.client_reference_id || '', 128),
    metadataItems: parseItemsFromMetadata(safeSession?.metadata || {}),
    quoteId: parseQuoteIdFromMetadata(safeSession?.metadata || {}),
    paymentRef: cleanString(safeSession?.id || '', 120),
    stripePaymentIntentId:
      typeof safeSession?.payment_intent === 'string'
        ? safeSession.payment_intent
        : cleanString(safeSession?.payment_intent?.id || '', 120) || null,
    shippingAddress: parseShippingFromMetadata(safeSession?.metadata || {}),
  };
}

export function createConfirmCheckoutSessionAndFulfill({
  stripe,
  fulfillPaidListings,
  parseItemsFromMetadata,
  parseQuoteIdFromMetadata,
  parseShippingFromMetadata,
  formatDisplayOrderNumber,
  cleanString = defaultCleanString,
}) {
  return async function confirmCheckoutSessionAndFulfill(sessionId) {
    const cleanSessionId = cleanString(sessionId || '', 120);
    if (!cleanSessionId) {
      return { ok: false, error: 'Missing checkout session id.', confirmationNumber: '#PENDING' };
    }

    const session = await stripe.checkout.sessions.retrieve(cleanSessionId);
    if (!session) {
      return {
        ok: false,
        error: 'Checkout session not found.',
        confirmationNumber: formatDisplayOrderNumber(cleanSessionId),
      };
    }

    if (session.payment_status !== 'paid') {
      return {
        ok: false,
        error: `Checkout session is not paid yet (status: ${session.payment_status || 'unknown'}).`,
        confirmationNumber: formatDisplayOrderNumber(cleanSessionId),
      };
    }

    const context = buildCheckoutFulfillmentContext({
      session,
      parseItemsFromMetadata,
      parseQuoteIdFromMetadata,
      parseShippingFromMetadata,
      cleanString,
    });

    if (!context.metadataItems.length) {
      return {
        ok: false,
        error: 'Checkout session is missing listing metadata.',
        confirmationNumber: formatDisplayOrderNumber(cleanSessionId),
        paymentIntentId: context.stripePaymentIntentId,
      };
    }

    const result = await fulfillPaidListings({
      paymentRef: cleanSessionId,
      stripePaymentIntentId: context.stripePaymentIntentId,
      buyerUid: context.buyerUid,
      quoteId: context.quoteId,
      shippingAddress: context.shippingAddress,
      rawItems: context.metadataItems,
      source: 'checkout_success_confirm',
    });

    return {
      ok: true,
      confirmationNumber: formatDisplayOrderNumber(cleanSessionId),
      paymentIntentId: context.stripePaymentIntentId,
      ...result,
    };
  };
}

export function verifyStripeWebhookEvent({
  stripe,
  webhookSecret,
  body,
  signature,
}) {
  if (!webhookSecret) {
    return {
      ok: false,
      statusCode: 500,
      body: { error: 'Missing STRIPE_WEBHOOK_SECRET.' },
    };
  }

  if (!signature) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: 'Missing stripe-signature header.' },
    };
  }

  try {
    return {
      ok: true,
      event: stripe.webhooks.constructEvent(body, signature, webhookSecret),
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: 'Invalid webhook signature.' },
      error: err,
    };
  }
}
