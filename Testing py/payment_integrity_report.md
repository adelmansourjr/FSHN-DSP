# Payment Integrity Test Report

Generated: 2026-04-03T20:44:53.280Z

Summary: total=4; passed=4; failed=0

| Check | Result | Expected | Actual |
| --- | --- | --- | --- |
| Unpaid checkout session rejection | Passed | Unpaid checkout sessions must not fulfil listings or create orders. | ok=false; error=Checkout session is not paid yet (status: unpaid).; fulfillCalls=0 |
| Missing listing metadata rejection | Passed | Paid checkout sessions without listing metadata must not fulfil listings. | ok=false; error=Checkout session is missing listing metadata.; fulfillCalls=0; paymentIntentId=pi_missing_meta |
| Invalid webhook signature rejection | Passed | Malformed or unsigned webhook traffic must be rejected before fulfilment logic runs. | ok=false; statusCode=400; error=Invalid webhook signature. |
| Duplicate fulfilment prevention | Passed | The same payment-plus-listing pair must map to the same order id and short-circuit duplicate fulfilment. | orderId=cs_paid_1__listing_1; duplicate=true; reason=order-already-exists |

## Notes

- Scope: local payment-integrity logic only; no live Stripe or live Firestore execution.
- Coverage: unpaid sessions, missing metadata, invalid webhooks, and duplicate-fulfilment protection.
