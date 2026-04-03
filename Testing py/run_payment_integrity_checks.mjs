import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createConfirmCheckoutSessionAndFulfill,
  orderDocId,
  validateFulfillmentOpportunity,
  verifyStripeWebhookEvent,
} from '../server/paymentIntegrity.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(SCRIPT_DIR, 'payment_integrity_results.json');
const REPORT_PATH = join(SCRIPT_DIR, 'payment_integrity_report.md');

function createCheck(id, name, expected, actual, passed, details = '') {
  return {
    id,
    name,
    expected,
    actual,
    passed,
    details,
  };
}

async function runUnpaidSessionCheck() {
  let fulfillCalls = 0;
  const confirmCheckoutSessionAndFulfill = createConfirmCheckoutSessionAndFulfill({
    stripe: {
      checkout: {
        sessions: {
          async retrieve() {
            return {
              id: 'cs_unpaid_1',
              payment_status: 'unpaid',
              metadata: {
                buyerUid: 'buyer_1',
                items_json: JSON.stringify([{ listingId: 'listing_1' }]),
              },
            };
          },
        },
      },
    },
    fulfillPaidListings: async () => {
      fulfillCalls += 1;
      return { processed: 1, skipped: 0, results: [{ listingId: 'listing_1', ok: true }] };
    },
    parseItemsFromMetadata: (metadata) => JSON.parse(metadata.items_json || '[]'),
    parseQuoteIdFromMetadata: (metadata) => String(metadata.quoteId || ''),
    parseShippingFromMetadata: () => ({ name: 'Ada Buyer' }),
    formatDisplayOrderNumber: (value) => `#${value}`,
  });

  const result = await confirmCheckoutSessionAndFulfill('cs_unpaid_1');
  const passed =
    result?.ok === false &&
    String(result?.error || '').includes('not paid yet') &&
    fulfillCalls === 0;

  return createCheck(
    'unpaid_checkout_session',
    'Unpaid checkout session rejection',
    'Unpaid checkout sessions must not fulfil listings or create orders.',
    `ok=${result?.ok}; error=${result?.error}; fulfillCalls=${fulfillCalls}`,
    passed,
  );
}

async function runMissingMetadataCheck() {
  let fulfillCalls = 0;
  const confirmCheckoutSessionAndFulfill = createConfirmCheckoutSessionAndFulfill({
    stripe: {
      checkout: {
        sessions: {
          async retrieve() {
            return {
              id: 'cs_paid_missing_meta',
              payment_status: 'paid',
              payment_intent: 'pi_missing_meta',
              metadata: {
                buyerUid: 'buyer_2',
              },
            };
          },
        },
      },
    },
    fulfillPaidListings: async () => {
      fulfillCalls += 1;
      return { processed: 1, skipped: 0, results: [{ listingId: 'listing_1', ok: true }] };
    },
    parseItemsFromMetadata: () => [],
    parseQuoteIdFromMetadata: () => '',
    parseShippingFromMetadata: () => ({ name: 'Ada Buyer' }),
    formatDisplayOrderNumber: (value) => `#${value}`,
  });

  const result = await confirmCheckoutSessionAndFulfill('cs_paid_missing_meta');
  const passed =
    result?.ok === false &&
    String(result?.error || '').includes('missing listing metadata') &&
    fulfillCalls === 0;

  return createCheck(
    'missing_checkout_metadata',
    'Missing listing metadata rejection',
    'Paid checkout sessions without listing metadata must not fulfil listings.',
    `ok=${result?.ok}; error=${result?.error}; fulfillCalls=${fulfillCalls}; paymentIntentId=${result?.paymentIntentId || 'null'}`,
    passed,
  );
}

async function runInvalidWebhookSignatureCheck() {
  const result = verifyStripeWebhookEvent({
    stripe: {
      webhooks: {
        constructEvent() {
          throw new Error('Signature mismatch');
        },
      },
    },
    webhookSecret: 'whsec_test',
    body: Buffer.from('{}'),
    signature: 'bad_signature',
  });

  const passed =
    result?.ok === false &&
    result?.statusCode === 400 &&
    result?.body?.error === 'Invalid webhook signature.';

  return createCheck(
    'invalid_webhook_signature',
    'Invalid webhook signature rejection',
    'Malformed or unsigned webhook traffic must be rejected before fulfilment logic runs.',
    `ok=${result?.ok}; statusCode=${result?.statusCode}; error=${result?.body?.error || 'none'}`,
    passed,
  );
}

async function runDuplicateFulfilmentCheck() {
  const firstOrderId = orderDocId('cs_paid_1', 'listing_1');
  const secondOrderId = orderDocId('cs_paid_1', 'listing_1');
  const opportunity = validateFulfillmentOpportunity({
    orderExists: true,
    listingExists: true,
    listingStatus: 'active',
    sellerUid: 'seller_1',
  });

  const passed =
    firstOrderId === secondOrderId &&
    opportunity?.duplicate === true &&
    opportunity?.reason === 'order-already-exists';

  return createCheck(
    'duplicate_fulfilment_prevention',
    'Duplicate fulfilment prevention',
    'The same payment-plus-listing pair must map to the same order id and short-circuit duplicate fulfilment.',
    `orderId=${firstOrderId}; duplicate=${String(opportunity?.duplicate)}; reason=${opportunity?.reason || 'none'}`,
    passed,
  );
}

async function main() {
  const checks = [
    await runUnpaidSessionCheck(),
    await runMissingMetadataCheck(),
    await runInvalidWebhookSignatureCheck(),
    await runDuplicateFulfilmentCheck(),
  ];

  const passed = checks.filter((check) => check.passed).length;
  const failed = checks.length - passed;
  const generatedAt = new Date().toISOString();

  const results = {
    generatedAt,
    summary: {
      total: checks.length,
      passed,
      failed,
    },
    checks,
  };

  const report = [
    '# Payment Integrity Test Report',
    '',
    `Generated: ${generatedAt}`,
    '',
    `Summary: total=${checks.length}; passed=${passed}; failed=${failed}`,
    '',
    '| Check | Result | Expected | Actual |',
    '| --- | --- | --- | --- |',
    ...checks.map((check) =>
      `| ${check.name} | ${check.passed ? 'Passed' : 'Failed'} | ${check.expected} | ${check.actual} |`
    ),
    '',
    '## Notes',
    '',
    '- Scope: local payment-integrity logic only; no live Stripe or live Firestore execution.',
    '- Coverage: unpaid sessions, missing metadata, invalid webhooks, and duplicate-fulfilment protection.',
    '',
  ].join('\n');

  await writeFile(RESULTS_PATH, JSON.stringify(results, null, 2));
  await writeFile(REPORT_PATH, report);

  console.log(`Payment integrity checks: ${passed}/${checks.length} passed`);
  if (failed) {
    const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name).join(', ');
    console.error(`Failed checks: ${failedChecks}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
