# Cloud Alerting Setup

Create log-based metrics and alerting policies for both deployable backends after the hardened rollout.

## Required Alerts

- `server/` payment route 5xx spike
- `server/` Stripe webhook failures
- `server/` auth-failure spike on protected routes
- `tryon-local/` 5xx spike on `/tryon`, `/recommend`, `/classify`, `/vision/search`
- `tryon-local/` latency spike on try-on and recommender routes
- `tryon-local/` auth-failure spike on protected AI routes

## Suggested Log Filters

Use the structured request logs added by the services:

### Payments API 5xx

```text
jsonPayload.service="payments-api"
jsonPayload.event="http_request"
jsonPayload.status>=500
```

### Stripe Webhook Failures

```text
textPayload:"stripe-webhook"
severity>=ERROR
```

### Try-On API 5xx

```text
jsonPayload.service="tryon-api"
jsonPayload.event="http_request"
jsonPayload.status>=500
```

### Auth Failure Spike

```text
jsonPayload.event="http_request"
jsonPayload.status=401
```

## Suggested Thresholds

- Payment or try-on 5xx: more than 5 errors in 5 minutes
- Webhook failures: any error in 5 minutes
- Auth spike: more than 20 `401` responses in 10 minutes
- Try-on latency: p95 above 30 seconds for 10 minutes
- Recommender latency: p95 above 10 seconds for 10 minutes

## Rollout Checklist

1. Create log-based metrics from the filters above.
2. Attach alert policies to the staging project first.
3. Force representative failures to confirm notification delivery.
4. Repeat for production.
5. Document the notification channel owners and escalation path.
