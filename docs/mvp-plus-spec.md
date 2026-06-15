# Dialer MVP+ Spec

## Goal

Build a simple Aircall-like calling app for outbound campaigns. The first version should move fast, but the data model must support a future distributed, multi-agent call center.

The app starts with one workspace and one primary user, but every core table should be workspace-aware and call activity should be attributable to an agent/user.

## Technical Direction

- Frontend: Vite + React.
- Backend: Express API.
- Database: Prisma with SQLite for MVP.
- Future database target: Postgres.
- Auth: Clerk.
- Calling: Telnyx WebRTC SDK.
- Initial workspace: auto-created for `michaelfackerell@gmail.com`.
- Initial deployment shape: private/internal web app on `127.0.0.1:3400`.

Vite + React is preferred over Next for this stage because the current app already has an Express server, the dialer is browser/WebRTC-heavy, and Express can own API routes, Prisma, Telnyx credentials, and Clerk auth verification without adding Next-specific runtime constraints.

## Product Scope

### MVP+ Included

- Login with Clerk.
- User table synchronized from Clerk identity.
- One default workspace for the initial user.
- Contacts/businesses with multiple phone numbers.
- Campaigns/lists with names, tags, settings, and progress.
- CSV import with preview, validation, duplicate detection, and automatic list/tag assignment.
- Dialer screen with current business/contact details.
- Queue/next-contact workflow.
- Manual number dialing retained.
- DNC/suppression table with hard blocking.
- DNC can be entered manually.
- DNC request from one contact/business blocks all phone numbers for that contact/business.
- Phone number matching normalizes formatting variants.
- Call attempt history for every dial attempt, including failed/blocked attempts.
- Required call outcome before advancing to next contact.
- Call notes.
- Callback reminders and callback queue.
- Optional recording metadata.
- Campaign-level recording default.
- Per-call recording override.
- Call diagnostics panel retained and expanded as needed.
- Basic dashboard/list progress.
- CSV export for contacts, call history, and DNC/suppression.

### Not In First MVP Unless Cheap

- Full role-based permissions.
- Multi-workspace UI.
- Billing.
- Predictive dialing.
- Power dialing with automatic next-call start.
- Team presence.
- Native mobile app.
- Full transcription pipeline, unless recording/transcript hooks are easy to stub.

## Auth And Workspace Model

Clerk handles login. The backend stores local user records so call activity and ownership can be queried without depending on Clerk as the primary data store.

On authenticated request:

1. Verify Clerk session.
2. Find or create `User` by Clerk user ID.
3. If the user's primary email is `michaelfackerell@gmail.com`, ensure a default workspace exists.
4. Ensure the user has a `WorkspaceMembership` for the default workspace.
5. Scope all API reads/writes by `workspace_id`.

Initial roles:

- `owner`
- `admin`
- `agent`

Only one user is required for MVP, but schema should support many.

## Core Concepts

### Workspace

A tenant boundary. Every campaign, contact, phone number, call, note, recording, transcript, and suppression entry belongs to a workspace.

### User / Agent

The authenticated person using the app. Calls and notes are attributed to the user.

### Contact

A business/person record. A contact can have multiple phone numbers.

Default fields:

- business name
- contact name
- email
- website
- address
- city
- state
- notes
- status
- tags

### Phone Number

A normalized phone number record. Store original/raw value and normalized E.164-ish value when possible.

Phone number uniqueness should be per workspace on normalized value.

### Campaign

A named calling list or campaign. Campaign settings include recording defaults and dialing behavior.

### Campaign Member

Joins a contact to a campaign. This allows the same contact to be in multiple campaigns while preserving per-campaign status, priority, attempts, assignment, and notes.

### Suppression Entry

Represents DNC, bad number, wrong number, blocked, or other suppression reasons.

DNC behavior:

- Exact normalized number matches are blocked.
- Formatting variants of the same number are blocked through normalization.
- If a contact/business requests DNC, all known phone numbers for that contact are blocked.
- DNC blocking is hard blocking: the app refuses to place the call and records a blocked call attempt.

### Call Attempt

Every dial attempt, including:

- blocked by DNC
- validation failure
- Telnyx setup failure
- no answer
- answered
- voicemail
- completed call

Call attempts are the source of truth for history and reporting.

## Screens

### Login

Clerk sign-in/sign-up.

### Dashboard

Initial cards:

- calls today
- answered calls today
- callbacks due
- DNC requests
- active campaigns
- campaign progress

### Campaigns

List campaigns with:

- name
- tags/categories
- recording default
- total contacts
- called
- remaining
- callbacks
- DNC blocked
- interested/qualified

Campaign detail includes:

- contact queue
- import history
- progress
- campaign settings

### Contacts

Searchable/filterable table:

- business name
- contact name
- phone numbers
- email
- website
- tags
- status
- last call outcome
- callback due

Filters:

- campaign
- status
- tag
- DNC status
- callback due
- text search

### Dialer

Primary workflow screen.

Shows:

- current campaign
- business name
- contact name
- phone numbers
- email
- website
- address
- tags
- previous call attempts
- notes
- DNC/suppression state
- selected number to dial
- mic/speaker controls
- call diagnostics
- recording control
- outcome buttons
- note field
- callback date/time
- next/skip controls

Actions:

- dial
- hang up
- mark DNC
- mark bad number
- add note
- set outcome
- create callback
- skip
- next eligible contact

### Call History

Table of all call attempts:

- timestamp
- user/agent
- campaign
- contact
- number
- status
- outcome
- duration
- recording/transcript status
- notes

### DNC / Suppression

Table and manual entry form:

- phone number
- normalized number
- contact/business
- suppression type
- reason
- source
- date added
- added by

Actions:

- add number
- add whole contact/business
- import CSV
- export CSV

### Callbacks

Queue of callback reminders:

- due time
- contact
- campaign
- phone
- last note
- assigned agent

## Call Outcomes

Initial outcomes:

- no answer
- left voicemail
- answered
- interested
- not interested
- callback requested
- do not call
- wrong number
- bad number
- gatekeeper
- needs follow-up

Outcome should be required after a connected call or after a completed attempt before advancing to the next queued contact.

## Recording And Transcription

Recording configuration:

- campaign default: `off`, `on`, or `ask_each_call`
- per-call override: `off` or `on`

Recording should not block MVP if Telnyx-side recording needs extra setup. The first implementation can store intended recording state and call metadata, then add actual recording capture/provider integration later.

Tables should exist for:

- `CallRecording`
- `CallTranscript`

Transcript states:

- `not_requested`
- `queued`
- `processing`
- `complete`
- `failed`

Compliance note: recording consent requirements vary by jurisdiction. The app should support an explicit consent/checklist field, but operational/legal policy is outside the app spec.

## CSV Import

Default columns:

- `business_name`
- `contact_name`
- `phone`
- `email`
- `website`
- `address`
- `city`
- `state`
- `notes`
- `tags`

Import behavior:

- Preview before save.
- Normalize phone numbers.
- Show invalid phone numbers.
- Detect duplicates by normalized phone number within workspace.
- Check against suppression/DNC before inserting into campaign queue.
- Allow multiple rows for the same business/contact if numbers differ.
- Assign imported contacts to selected campaign.
- Apply import-level tags.
- Store import batch metadata.

Future-compatible support:

- Multiple phone columns later, e.g. `phone_2`, `mobile`, `main_phone`.

## Database Model

Use Prisma migrations from the start. Prefer UUID/string IDs for future portability.

Required models:

- `Workspace`
- `User`
- `WorkspaceMembership`
- `Campaign`
- `Tag`
- `Contact`
- `PhoneNumber`
- `ContactPhoneNumber`
- `CampaignMember`
- `SuppressionEntry`
- `CallAttempt`
- `CallNote`
- `CallbackReminder`
- `ImportBatch`
- `ImportRow`
- `CallRecording`
- `CallTranscript`

### Important Fields

Common fields on most models:

- `id`
- `workspaceId`
- `createdAt`
- `updatedAt`

`User`:

- `clerkUserId`
- `email`
- `name`

`Campaign`:

- `workspaceId`
- `name`
- `description`
- `status`
- `recordingDefault`
- `maxAttempts`
- `createdByUserId`

`Contact`:

- `workspaceId`
- `businessName`
- `contactName`
- `email`
- `website`
- `address`
- `city`
- `state`
- `status`
- `notes`

`PhoneNumber`:

- `workspaceId`
- `rawNumber`
- `normalizedNumber`
- `countryCode`
- `isValid`

`ContactPhoneNumber`:

- `workspaceId`
- `contactId`
- `phoneNumberId`
- `label`
- `isPrimary`

`CampaignMember`:

- `workspaceId`
- `campaignId`
- `contactId`
- `status`
- `priority`
- `assignedToUserId`
- `attemptCount`
- `lastAttemptAt`
- `nextCallbackAt`

`SuppressionEntry`:

- `workspaceId`
- `phoneNumberId`
- `contactId`
- `normalizedNumber`
- `type`
- `reason`
- `source`
- `addedByUserId`
- `scope`

Suppression `type` values:

- `do_not_call`
- `bad_number`
- `wrong_number`
- `blocked`

Suppression `scope` values:

- `number`
- `contact`

`CallAttempt`:

- `workspaceId`
- `campaignId`
- `campaignMemberId`
- `contactId`
- `phoneNumberId`
- `agentUserId`
- `direction`
- `status`
- `outcome`
- `startedAt`
- `answeredAt`
- `endedAt`
- `durationSeconds`
- `telnyxSessionId`
- `telnyxLegId`
- `telnyxCallControlId`
- `sipCode`
- `sipReason`
- `failureReason`
- `recordingRequested`
- `recordingConsentChecked`
- `blockedBySuppressionEntryId`

`CallNote`:

- `workspaceId`
- `callAttemptId`
- `contactId`
- `authorUserId`
- `body`

`CallbackReminder`:

- `workspaceId`
- `campaignMemberId`
- `contactId`
- `phoneNumberId`
- `assignedToUserId`
- `dueAt`
- `status`
- `note`

`CallRecording`:

- `workspaceId`
- `callAttemptId`
- `provider`
- `providerRecordingId`
- `url`
- `status`
- `durationSeconds`

`CallTranscript`:

- `workspaceId`
- `callRecordingId`
- `callAttemptId`
- `provider`
- `status`
- `text`
- `summary`
- `error`

## API Shape

All API routes require Clerk auth except health checks.

Suggested routes:

- `GET /api/me`
- `GET /api/dashboard`
- `GET /api/campaigns`
- `POST /api/campaigns`
- `GET /api/campaigns/:id`
- `PATCH /api/campaigns/:id`
- `GET /api/campaigns/:id/queue/next`
- `POST /api/imports/preview`
- `POST /api/imports/commit`
- `GET /api/contacts`
- `POST /api/contacts`
- `GET /api/contacts/:id`
- `PATCH /api/contacts/:id`
- `GET /api/call-attempts`
- `POST /api/call-attempts`
- `PATCH /api/call-attempts/:id`
- `POST /api/call-attempts/:id/notes`
- `GET /api/suppressions`
- `POST /api/suppressions`
- `POST /api/suppressions/check`
- `GET /api/callbacks`
- `PATCH /api/callbacks/:id`
- `GET /api/telnyx-credentials`

Before dialing, frontend must call a suppression check or create a call attempt that returns whether dialing is allowed.

## Dialing Flow

1. User opens Dialer.
2. User selects campaign or manual dial.
3. App fetches next eligible campaign member.
4. App displays contact/business details and available phone numbers.
5. User clicks `Dial`.
6. Backend creates `CallAttempt` with `status = preparing`.
7. Backend checks suppression/DNC.
8. If blocked:
   - set `CallAttempt.status = blocked`
   - store suppression reference
   - frontend refuses to call
9. If allowed:
   - frontend connects Telnyx if needed
   - frontend places WebRTC call
   - call attempt is updated with Telnyx IDs and call state
10. During call:
   - diagnostics update once per second
   - recording state is shown
11. After call:
   - user selects outcome
   - user adds notes/callback if needed
   - campaign member status/attempt counters update
   - user can move to next contact

## DNC Guardrail

The app must never rely only on UI disablement for DNC. The backend must enforce suppression checks before creating an allowed dial attempt.

If suppression is found:

- frontend shows blocking reason
- call is not placed
- blocked attempt is logged

## Reporting

Initial reporting:

- calls today
- calls by outcome
- campaign progress
- callbacks due
- DNC requests
- attempts per contact
- blocked calls
- recordings/transcripts status

## Implementation Phases

### Phase 1: App Foundation

- Convert frontend to React.
- Add Clerk login.
- Add Prisma + SQLite.
- Add workspace/user bootstrap for `michaelfackerell@gmail.com`.
- Add authenticated Express API helper.

### Phase 2: Core CRM

- Prisma models and migrations.
- Contacts, phone numbers, campaigns, tags.
- Contacts/campaigns UI.
- CSV import preview/commit.

### Phase 3: Dialer Workflow

- Campaign queue.
- Contact card.
- Suppression check before dialing.
- Call attempt creation/update.
- Outcome + notes.
- Callback reminders.

### Phase 4: DNC And Reporting

- DNC/suppression UI.
- Manual DNC entry.
- Contact-wide DNC blocking.
- Dashboard and call history.
- CSV exports.

### Phase 5: Recording/Transcription Hooks

- Campaign recording defaults.
- Per-call override.
- Recording metadata table.
- Transcript status table.
- Provider integration later.

## Open Questions

- Which Clerk application/environment should be used for development?
- Should CSV imports merge into existing contacts by normalized phone, business name, or both?
- Should campaign queue ordering be manual priority, oldest imported first, or least recently attempted first?
- What exact Telnyx recording mechanism should be used when we implement real recording?
- Should DNC entries ever be removable, or only archived/deactivated with audit history?
