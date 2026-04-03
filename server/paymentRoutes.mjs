import { buildCheckoutFulfillmentContext, verifyStripeWebhookEvent } from './paymentIntegrity.mjs';

export function buildStripeWebhookHandler({
  stripe,
  webhookSecret,
  parseItemsFromMetadata,
  parseQuoteIdFromMetadata,
  parseShippingFromMetadata,
  cleanString,
  fulfillPaidListings,
  logger = console,
}) {
  return async function stripeWebhookHandler(req, res) {
    const verified = verifyStripeWebhookEvent({
      stripe,
      webhookSecret,
      body: req.body,
      signature: req.headers['stripe-signature'],
    });
    if (!verified.ok) {
      if (verified.error) {
        logger.error?.('[stripe-webhook] signature verification failed', verified.error);
      }
      return res.status(verified.statusCode).json(verified.body);
    }

    const { event } = verified;

    try {
      if (
        event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded'
      ) {
        const session = event.data.object;
        if (session?.payment_status !== 'paid') {
          return res.json({ received: true, skipped: 'session-not-paid' });
        }

        const context = buildCheckoutFulfillmentContext({
          session,
          parseItemsFromMetadata,
          parseQuoteIdFromMetadata,
          parseShippingFromMetadata,
          cleanString,
        });

        if (context.paymentRef && context.metadataItems.length) {
          const result = await fulfillPaidListings({
            paymentRef: context.paymentRef,
            stripePaymentIntentId: context.stripePaymentIntentId,
            buyerUid: context.buyerUid,
            quoteId: context.quoteId,
            shippingAddress: context.shippingAddress,
            rawItems: context.metadataItems,
            source: 'stripe_checkout_webhook',
          });
          logger.log?.('[stripe-webhook] checkout fulfillment', {
            paymentRef: context.paymentRef,
            ...result,
          });
        } else {
          logger.warn?.('[stripe-webhook] missing metadata for checkout fulfillment', {
            paymentRef: context.paymentRef,
            itemCount: context.metadataItems.length,
          });
        }
      }

      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const buyerUid = cleanString(paymentIntent?.metadata?.buyerUid || '', 128);
        const metadataItems = parseItemsFromMetadata(paymentIntent?.metadata || {});
        const quoteId = parseQuoteIdFromMetadata(paymentIntent?.metadata || {});
        const paymentRef = cleanString(paymentIntent?.id || '', 120);

        if (paymentRef && metadataItems.length) {
          const result = await fulfillPaidListings({
            paymentRef,
            stripePaymentIntentId: paymentRef,
            buyerUid,
            quoteId,
            shippingAddress: parseShippingFromMetadata(paymentIntent?.metadata || {}),
            rawItems: metadataItems,
            source: 'stripe_payment_intent_webhook',
          });
          logger.log?.('[stripe-webhook] payment intent fulfillment', { paymentRef, ...result });
        }
      }

      return res.json({ received: true });
    } catch (err) {
      logger.error?.('[stripe-webhook] handler failed', err);
      return res.status(500).json({ error: 'Webhook handler failed.' });
    }
  };
}

export function buildFinalizePaymentIntentHandler({
  requireRequestAuthUid,
  stripe,
  cleanString,
  parseItemsFromMetadata,
  parseQuoteIdFromMetadata,
  parseShippingFromMetadata,
  fulfillPaidListings,
  logStructured = () => {},
}) {
  return async function finalizePaymentIntentHandler(req, res) {
    try {
      const buyerUid = await requireRequestAuthUid(req);
      const { paymentIntentId, shippingAddress = null } = req.body || {};
      const cleanPaymentIntentId = cleanString(paymentIntentId || '', 120);
      if (!cleanPaymentIntentId) {
        return res.status(400).json({ error: 'Missing paymentIntentId.' });
      }

      const paymentIntent = await stripe.paymentIntents.retrieve(cleanPaymentIntentId);
      if (!paymentIntent || paymentIntent.status !== 'succeeded') {
        return res.status(409).json({
          error: `PaymentIntent ${cleanPaymentIntentId} is not succeeded.`,
          status: paymentIntent?.status || 'unknown',
        });
      }

      const metadataItems = parseItemsFromMetadata(paymentIntent.metadata || {});
      const quoteId = parseQuoteIdFromMetadata(paymentIntent.metadata || {});
      if (!metadataItems.length) {
        return res.status(400).json({
          error: 'Payment intent is missing listing metadata and cannot be finalized securely.',
        });
      }

      const metadataBuyerUid = cleanString(paymentIntent.metadata?.buyerUid || '', 128);
      if (!metadataBuyerUid || metadataBuyerUid !== buyerUid) {
        return res.status(403).json({
          error: 'Payment intent ownership does not match the authenticated user.',
        });
      }

      const result = await fulfillPaidListings({
        paymentRef: cleanPaymentIntentId,
        stripePaymentIntentId: cleanPaymentIntentId,
        buyerUid,
        quoteId,
        shippingAddress: shippingAddress || parseShippingFromMetadata(paymentIntent.metadata || {}),
        rawItems: metadataItems,
        source: 'mobile_finalize_endpoint',
      });

      return res.json({
        ok: true,
        paymentIntentId: cleanPaymentIntentId,
        ...result,
      });
    } catch (err) {
      const statusCode = Number(err?.statusCode || 0);
      if (statusCode === 401) {
        return res
          .status(401)
          .json({ error: String(err?.message || 'Authentication required.') });
      }
      logStructured('error', 'finalize_payment_intent_failed', {
        requestId: req.requestId,
        message: String(err?.message || err),
      });
      return res.status(500).json({ error: 'Failed to finalize payment intent.' });
    }
  };
}

export function registerPaymentRoutes(
  app,
  {
    expressModule,
    stripe,
    webhookSecret,
    parseItemsFromMetadata,
    parseQuoteIdFromMetadata,
    parseShippingFromMetadata,
    cleanString,
    fulfillPaidListings,
    requireRequestAuthUid,
    logStructured,
    logger = console,
  },
) {
  app.post(
    '/stripe-webhook',
    expressModule.raw({ type: 'application/json' }),
    buildStripeWebhookHandler({
      stripe,
      webhookSecret,
      parseItemsFromMetadata,
      parseQuoteIdFromMetadata,
      parseShippingFromMetadata,
      cleanString,
      fulfillPaidListings,
      logger,
    }),
  );

  app.use(expressModule.json());

  app.post(
    '/finalize-payment-intent',
    buildFinalizePaymentIntentHandler({
      requireRequestAuthUid,
      stripe,
      cleanString,
      parseItemsFromMetadata,
      parseQuoteIdFromMetadata,
      parseShippingFromMetadata,
      fulfillPaidListings,
      logStructured,
    }),
  );
}
