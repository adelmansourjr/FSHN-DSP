import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { registerPaymentRoutes } from '../paymentRoutes.mjs';

function cleanString(value, maxLen = 200) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLen);
}

function parseItemsFromMetadata(metadata = {}) {
  try {
    return JSON.parse(String(metadata.items_json || '[]'));
  } catch {
    return [];
  }
}

function parseQuoteIdFromMetadata(metadata = {}) {
  return cleanString(metadata.quoteId || '', 180);
}

function parseShippingFromMetadata(metadata = {}) {
  return {
    name: cleanString(metadata.shippingName || 'Ada Buyer', 120) || 'Ada Buyer',
  };
}

function createTestApp({
  webhookSecret = 'whsec_test',
  stripeSession = null,
  stripeEvent = null,
  paymentIntent = null,
  authUid = 'buyer_1',
  fulfillPaidListings = async () => ({
    processed: 1,
    skipped: 0,
    results: [{ listingId: 'listing_1', ok: true }],
  }),
  constructEventError = null,
} = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = 'test-request-id';
    next();
  });

  registerPaymentRoutes(app, {
    expressModule: express,
    stripe: {
      checkout: {
        sessions: {
          async retrieve() {
            return stripeSession;
          },
        },
      },
      paymentIntents: {
        async retrieve() {
          return paymentIntent;
        },
      },
      webhooks: {
        constructEvent() {
          if (constructEventError) throw constructEventError;
          return stripeEvent;
        },
      },
    },
    webhookSecret,
    parseItemsFromMetadata,
    parseQuoteIdFromMetadata,
    parseShippingFromMetadata,
    cleanString,
    fulfillPaidListings,
    requireRequestAuthUid: async () => authUid,
    logStructured: () => {},
    logger: {
      log() {},
      warn() {},
      error() {},
    },
  });

  return app;
}

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test('POST /stripe-webhook rejects requests missing stripe-signature', async () => {
  const app = createTestApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/stripe-webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Missing stripe-signature header.',
    });
  });
});

test('POST /stripe-webhook rejects invalid webhook signatures', async () => {
  const app = createTestApp({
    constructEventError: new Error('Signature mismatch'),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/stripe-webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'bad_signature',
      },
      body: JSON.stringify({ id: 'evt_invalid' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Invalid webhook signature.',
    });
  });
});

test('POST /finalize-payment-intent rejects buyer mismatch', async () => {
  const app = createTestApp({
    authUid: 'buyer_1',
    paymentIntent: {
      id: 'pi_buyer_mismatch',
      status: 'succeeded',
      metadata: {
        buyerUid: 'buyer_2',
        items_json: JSON.stringify([{ listingId: 'listing_1', qty: 1, unitAmount: 1200 }]),
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/finalize-payment-intent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paymentIntentId: 'pi_buyer_mismatch' }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'Payment intent ownership does not match the authenticated user.',
    });
  });
});

test('POST /finalize-payment-intent rejects missing listing metadata', async () => {
  let fulfillCalls = 0;
  const app = createTestApp({
    paymentIntent: {
      id: 'pi_missing_metadata',
      status: 'succeeded',
      metadata: {
        buyerUid: 'buyer_1',
      },
    },
    fulfillPaidListings: async () => {
      fulfillCalls += 1;
      return { processed: 1, skipped: 0, results: [] };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/finalize-payment-intent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paymentIntentId: 'pi_missing_metadata' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Payment intent is missing listing metadata and cannot be finalized securely.',
    });
    assert.equal(fulfillCalls, 0);
  });
});

test('POST /finalize-payment-intent rejects non-succeeded payment intents', async () => {
  const app = createTestApp({
    paymentIntent: {
      id: 'pi_processing',
      status: 'processing',
      metadata: {
        buyerUid: 'buyer_1',
        items_json: JSON.stringify([{ listingId: 'listing_1', qty: 1, unitAmount: 1200 }]),
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/finalize-payment-intent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paymentIntentId: 'pi_processing' }),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'PaymentIntent pi_processing is not succeeded.',
      status: 'processing',
    });
  });
});

test('POST /finalize-payment-intent completes a valid paid intent', async () => {
  let captured = null;
  const app = createTestApp({
    paymentIntent: {
      id: 'pi_success',
      status: 'succeeded',
      metadata: {
        buyerUid: 'buyer_1',
        quoteId: 'quote_1',
        shippingName: 'Ada Buyer',
        items_json: JSON.stringify([{ listingId: 'listing_1', qty: 1, unitAmount: 1200 }]),
      },
    },
    fulfillPaidListings: async (payload) => {
      captured = payload;
      return { processed: 1, skipped: 0, results: [{ listingId: 'listing_1', ok: true }] };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/finalize-payment-intent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paymentIntentId: 'pi_success' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      paymentIntentId: 'pi_success',
      processed: 1,
      skipped: 0,
      results: [{ listingId: 'listing_1', ok: true }],
    });
    assert.deepEqual(captured, {
      paymentRef: 'pi_success',
      stripePaymentIntentId: 'pi_success',
      buyerUid: 'buyer_1',
      quoteId: 'quote_1',
      shippingAddress: { name: 'Ada Buyer' },
      rawItems: [{ listingId: 'listing_1', qty: 1, unitAmount: 1200 }],
      source: 'mobile_finalize_endpoint',
    });
  });
});
