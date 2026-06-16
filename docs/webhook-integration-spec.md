# Webhook Integration Spec

## Overview

The dialer supports outbound webhooks that fire on call events, enabling integration with n8n, Zapier, Make, or any HTTP endpoint. This keeps the dialer focused on calling while allowing follow-up automation (CRM sync, email sequences, Slack notifications, etc.) to live elsewhere.

## Architecture

```
[Dialer] --HTTP POST--> [n8n / Zapier / Make / Custom endpoint]
                            |
                            +---> SalesFu CRM
                            +---> HubSpot / Salesforce / Pipedrive
                            +---> Email (follow-up sequences)
                            +---> Slack notifications
                            +---> Task creation
                            +---> Spreadsheet logging
```

The dialer never receives inbound webhooks. It only makes outbound POSTs to user-configured URLs. This means:

- No inbound ports to open beyond the existing Express server
- No webhook signature verification needed on the dialer side (the dialer is the sender)
- The integration endpoint (n8n, etc.) is responsible for authentication/validation of incoming payloads
- The dialer's server IP is never exposed to the integration endpoint's server

## Security Considerations

- Webhook URLs are stored in the database, workspace-scoped
- Each webhook has an optional shared secret. If set, the dialer signs payloads with `HMAC-SHA256` using the secret and sends the signature in an `X-Webhook-Signature` header
- Webhook secrets are never returned via the API after creation (only a masked hint)
- The dialer does not store or log webhook response bodies
- Failed deliveries are retried up to 3 times with exponential backoff (1s, 5s, 25s)
- Webhook payloads contain workspace-scoped IDs only — no cross-tenant data leakage

## Data Model

### WebhookEndpoint

Stores the target URL, secret, and configuration for a webhook destination.

| Field | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| workspaceId | UUID | Workspace scope |
| name | String | Human-readable label, e.g. "n8n - SalesFu sync" |
| url | String | HTTPS endpoint URL |
| secret | String? | HMAC-SHA256 signing secret |
| active | Boolean | Whether this endpoint receives events |
| createdAt | DateTime | |
| updatedAt | DateTime | |

### WebhookEvent

Audit log of every webhook the dialer attempted to send.

| Field | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| workspaceId | UUID | Workspace scope |
| endpointId | UUID | Foreign key to WebhookEndpoint |
| eventType | String | Event type, e.g. `call.completed` |
| payload | String (JSON) | Full payload sent |
| status | Enum | `pending`, `delivered`, `failed` |
| attempts | Int | Number of delivery attempts |
| lastAttemptAt | DateTime? | |
| responseStatus | Int? | HTTP status code from last attempt |
| createdAt | DateTime | |
| updatedAt | DateTime | |

### WebhookEventStatus Enum

- `pending` — queued for delivery
- `delivered` — endpoint responded 2xx
- `failed` — all retries exhausted or endpoint responded non-2xx

### Event Types

| Event | Trigger | When |
|---|---|---|
| `call.completed` | After call outcome saved | Any call attempt that has a final outcome |
| `call.answered` | Call was answered | `answeredAt` is set |
| `call.outcome.interested` | Specific outcome | Outcome set to `interested` |
| `call.outcome.callback_requested` | Specific outcome | Outcome set to `callback_requested` |
| `call.outcome.not_interested` | Specific outcome | Outcome set to `not_interested` |
| `call.outcome.do_not_call` | Specific outcome | Outcome set to `do_not_call` |
| `contact.dnc_added` | DNC suppression created | New SuppressionEntry created |
| `callback.due` | Callback reminder is due | Open callback where `dueAt <= now` |

Each webhook endpoint subscribes to one or more event types. Subscriptions are stored as a simple join table.

### WebhookSubscription

| Field | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| endpointId | UUID | Foreign key to WebhookEndpoint |
| eventType | String | Event type to subscribe to |

If an endpoint has no subscriptions, it receives all events.

## Payload Format

All webhooks send a `POST` with `Content-Type: application/json`.

### Headers

```
Content-Type: application/json
X-Webhook-Signature: <HMAC-SHA256 hex digest of body using endpoint secret>
X-Webhook-Event: <event type, e.g. call.completed>
X-Webhook-Delivery: <unique delivery ID>
X-Webhook-Timestamp: <ISO 8601 UTC timestamp>
```

### Example: `call.completed`

```json
{
  "event": "call.completed",
  "deliveryId": "evt_01HXYZ...",
  "timestamp": "2026-06-16T14:32:00.000Z",
  "workspaceId": "ws_abc123",
  "data": {
    "callAttempt": {
      "id": "ca_abc123",
      "direction": "outbound",
      "status": "completed",
      "outcome": "interested",
      "startedAt": "2026-06-16T14:30:00.000Z",
      "answeredAt": "2026-06-16T14:30:15.000Z",
      "endedAt": "2026-06-16T14:32:00.000Z",
      "durationSeconds": 105,
      "recordingRequested": false
    },
    "contact": {
      "id": "ct_abc123",
      "businessName": "Acme HVAC",
      "contactName": "John Smith",
      "email": "john@acme.com",
      "phoneNumbers": [
        { "normalizedNumber": "+15205551234", "label": "main", "isPrimary": true }
      ]
    },
    "campaign": {
      "id": "cmp_abc123",
      "name": "Phoenix HVAC Q2"
    },
    "notes": [
      { "body": "Very interested in annual service contract", "author": "michael@example.com" }
    ],
    "callback": {
      "id": "cb_abc123",
      "dueAt": "2026-06-17T10:00:00.000Z",
      "note": "Call back in morning"
    }
  }
}
```

### Example: `call.outcome.interested`

Same structure as `call.completed` but only fires for the `interested` outcome. Useful for triggering CRM creation or high-priority notifications.

### Example: `contact.dnc_added`

```json
{
  "event": "contact.dnc_added",
  "deliveryId": "evt_01HXYZ...",
  "timestamp": "2026-06-16T14:32:00.000Z",
  "workspaceId": "ws_abc123",
  "data": {
    "suppression": {
      "id": "sup_abc123",
      "type": "do_not_call",
      "scope": "contact",
      "reason": "Requested by contact",
      "source": "call_outcome"
    },
    "contact": {
      "id": "ct_abc123",
      "businessName": "Acme HVAC",
      "contactName": "John Smith"
    },
    "phoneNumber": {
      "normalizedNumber": "+15205551234"
    }
  }
}
```

## API Routes

### Webhook Endpoint CRUD

```
GET    /api/webhooks                    List all webhook endpoints for workspace
POST   /api/webhooks                    Create a webhook endpoint
GET    /api/webhooks/:id                Get endpoint details
PATCH  /api/webhooks/:id                Update endpoint (name, url, secret, active)
DELETE /api/webhooks/:id                 Delete endpoint and subscriptions
POST   /api/webhooks/:id/test           Send a test payload to the endpoint
```

### Webhook Subscriptions

```
GET    /api/webhooks/:id/subscriptions       List subscriptions for an endpoint
POST   /api/webhooks/:id/subscriptions       Set subscriptions (replaces all)
DELETE /api/webhooks/:id/subscriptions/:type  Remove a subscription
```

### Webhook Event Log

```
GET    /api/webhooks/events               List recent webhook delivery events
GET    /api/webhooks/events/:id           Get event details including payload
POST   /api/webhooks/events/:id/retry     Manually retry a failed event
```

### Manual Trigger

```
POST   /api/webhooks/:id/trigger          Manually fire a webhook with current call data
```

Used by the "Send to n8n" button in the UI. Body:

```json
{
  "callAttemptId": "ca_abc123",
  "eventType": "call.completed"
}
```

## UI Screens

### Webhook Settings (new nav item: "Integrations")

A settings page under a new "Integrations" nav item (or under a gear/settings nav).

**Endpoint List:**

- Name, URL, active status, event subscriptions
- Add endpoint button
- Test button (sends sample payload)
- Delete button

**Add/Edit Endpoint:**

- Name (e.g. "n8n — SalesFu sync")
- URL (e.g. `https://n8n.example.com/webhook/call-complete`)
- Secret (optional, for HMAC signing)
- Active toggle
- Event subscriptions: checkboxes for each event type
- Test button

**Event Log:**

- Recent deliveries with status (delivered/failed/pending)
- Expand to see full payload
- Retry button for failed events

### Post-Call "Send to n8n" Button

On the call outcome form, after saving an outcome, a "Send to n8n" button appears. Clicking it:

1. Shows a dropdown of active webhook endpoints
2. Selects one (or "All active endpoints")
3. Fires the webhook immediately with the current call data
4. Shows success/failure feedback

This is in addition to automatic webhook firing. Automatic webhooks fire on every qualifying event. The manual button is for re-sending or for cases where the user wants explicit control.

### Dialer View Enhancement

In the dialer's post-call outcome panel, after the outcome is saved:

- If webhooks are configured: show a "Send to n8n" / "Trigger webhook" button
- If no webhooks are configured: show a subtle link "Set up integrations" that navigates to the Integrations settings page

## Backend: Webhook Delivery Engine

### Firing Logic

When a qualifying event occurs (call outcome saved, DNC added, etc.):

1. Look up all active `WebhookEndpoint` records for the workspace
2. Filter by subscriptions matching the event type (or include if endpoint has no subscriptions = all events)
3. For each matching endpoint, create a `WebhookEvent` record with status `pending`
4. Attempt immediate delivery
5. On success (2xx response), mark event as `delivered`
6. On failure, increment attempts and schedule retry with exponential backoff

### Delivery Implementation

```
async function deliverWebhook(event, endpoint):
  body = JSON.stringify(event.payload)
  signature = endpoint.secret ? hmacSha256(body, endpoint.secret) : null
  headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': event.eventType,
    'X-Webhook-Delivery': event.id,
    'X-Webhook-Timestamp': event.timestamp,
    ...(signature && { 'X-Webhook-Signature': signature }),
  }
  response = await fetch(endpoint.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) })
  event.responseStatus = response.status
  return response.ok
```

### Retry Schedule

- Attempt 1: immediate
- Attempt 2: after 1 second
- Attempt 3: after 5 seconds
- Attempt 4: after 25 seconds
- After 4 failed attempts: mark as `failed`, no further retries (manual retry available)

Retries are implemented using `setTimeout` in-process. For the single-user MVP this is sufficient. A future production version could use a job queue.

## n8n Setup Guide (for docs/readme)

### Self-Hosted n8n

Recommended: deploy n8n on a separate server/VPS to isolate the dialer's IP.

```sh
# docker-compose.yml
version: '3.8'
services:
  n8n:
    image: n8nio/n8n
    ports:
      - '5678:5678'
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=admin
      - N8N_BASIC_AUTH_PASSWORD=<your-password>
      - WEBHOOK_URL=https://n8n.yourdomain.com/
    volumes:
      - n8n_data:/home/node/.n8n
    restart: unless-stopped
volumes:
  n8n_data:
```

### n8n Cloud

For users who don't want to self-host, n8n Cloud provides managed instances. Users just paste their webhook URL into the dialer settings.

### Example n8n Workflow

1. **Webhook Trigger** node — receives POST from dialer
2. **Switch** node — routes by `event` type
3. **HTTP Request** node — pushes to HubSpot/SalesFu/Pipedrive
4. **Send Email** node — sends follow-up for `interested` outcomes
5. **Slack** node — posts notification for `callback_requested`

## Implementation Order

### Phase 1: Data model + API

1. Add `WebhookEndpoint`, `WebhookSubscription`, `WebhookEvent` models to Prisma schema
2. Run migration
3. Add CRUD API routes for webhook endpoints and subscriptions
4. Add event log API routes

### Phase 2: Delivery engine

1. Implement `deliverWebhook` function with HMAC signing
2. Implement retry logic with exponential backoff
3. Hook into existing event points:
   - After call outcome saved (`call.completed`, `call.outcome.*`)
   - After DNC suppression created (`contact.dnc_added`)
   - On callback due check (`callback.due`)

### Phase 3: UI — Integrations settings

1. Add "Integrations" nav item
2. Build endpoint list, add/edit form with event subscription checkboxes
3. Build test button that fires a sample payload
4. Build event log with retry for failed deliveries

### Phase 4: UI — Post-call trigger

1. Add "Send to n8n" button to outcome panel
2. Show endpoint selector dropdown
3. Show success/failure feedback
4. Show "Set up integrations" link when no endpoints configured

### Phase 5: Manual trigger API

1. `POST /api/webhooks/:id/trigger` endpoint
2. `POST /api/webhooks/:id/test` endpoint with sample data

## Open Questions

- Should webhook delivery be synchronous (fire-and-forget after response) or should we await delivery before returning to the user? **Recommendation: fire-and-forget with event log for observability.**
- Should we support custom payload templates per endpoint? **Recommendation: no for MVP, use the standard format. Can add Jinja-style templating later.**
- Should failed webhooks show a notification in the dialer UI? **Recommendation: yes, as a subtle banner, but don't block the user.**
- Rate limiting for webhook deliveries? **Recommendation: not for MVP, single-user app.**