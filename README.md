# Telnyx Browser Dialer

A browser-based outbound dialer for call campaigns, built with React + Express + Prisma/SQLite + Telnyx WebRTC.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create your environment file:

   ```sh
   cp .env.example .env
   ```

3. Set Telnyx auth in `.env`. Prefer `TELNYX_LOGIN_TOKEN` with a Telnyx WebRTC JWT/login token. Alternatively, set `TELNYX_SIP_USERNAME` and `TELNYX_SIP_PASSWORD`. Optionally set `TELNYX_CALLER_NUMBER` to your caller ID in E.164 format.

4. Set up the database:

   ```sh
   npm run db:migrate
   ```

5. Run the dev server:

   ```sh
   npm run dev
   ```

Open `http://127.0.0.1:3400` in Chrome. Enter a destination number in E.164 format (e.g. `+15551234567`) and click Dial. The first call requests microphone access and connects to Telnyx automatically.

## Production Build

```sh
npm run build
NODE_ENV=production npm run preview
```

## Features

### Dashboard

Overview metrics: campaigns, contacts, calls today, answered today, callbacks due, DNC entries. Recent calls table.

### Campaigns

- Create campaigns with name, description, and recording default (off/on/ask each call).
- Import CSV files into a campaign (columns: name, phone, address, website, rating, reviews).
- Click a campaign to see its detail view with member list (business, contact, phone, queue status, attempts, last called, last outcome).
- Pause, resume, or archive campaigns from the detail view.

### Contacts

- Searchable contact list with columns: business name, contact name, phone, status, DNC flag.
- Click a contact to see full detail: all fields, notes, phone numbers, campaigns, call history, and callbacks.
- Edit any contact field (business name, contact name, email, website, address, city, state, status, DNC flag, notes).
- Contact detail includes all call attempts with date, status, outcome, duration, phone, campaign, and notes.

### Dialer

- Select a campaign to dial through the queue, or dial manually.
- "Next" loads the next queued contact. "Skip" marks the current contact as skipped. "Callback 1h" schedules a callback for 1 hour from now.
- After a call ends, an outcome form appears: select outcome (answered, no answer, voicemail, interested, not interested, callback requested, gatekeeper, needs follow up, wrong/bad number, do not call), add notes, flag DNC, and optionally schedule a callback date.
- Call diagnostics panel shows network quality, codec, ICE route.
- Mic/speaker selection and testing.

### DNC / Suppression

- Add phone numbers to the do-not-call list manually.
- DNC entries block dialing at the number or contact level.
- DNC is enforced server-side before any call is placed.

### Call History

- Table of all call attempts with contact, number, status, outcome, campaign, and agent.

## CSV Import

Upload a CSV file to import contacts into a campaign. Supported columns:

| Column    | Maps to      |
|-----------|-------------|
| name      | businessName |
| phone     | phoneNumber  |
| address   | address      |
| website   | website      |
| rating    | notes        |
| reviews   | notes        |
| place_id  | notes        |

City and state are parsed from the address field if present. Invalid rows (missing name or no valid phone) are skipped and counted in the import result.

## API Endpoints

All endpoints are prefixed with `/api` and require authentication.

### Auth & Workspace

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me` | Current user and workspace info |
| GET | `/dashboard` | Dashboard metrics and recent calls |
| GET | `/telnyx-credentials` | Telnyx WebRTC credentials |

### Campaigns

| Method | Path | Description |
|--------|------|-------------|
| GET | `/campaigns` | List campaigns with member/call counts |
| POST | `/campaigns` | Create a campaign |
| PATCH | `/campaigns/:id` | Update campaign (name, description, status, recordingDefault, maxAttempts) |
| GET | `/campaigns/:id/members` | List members with contact details and last call info |
| GET | `/campaigns/:id/queue/next` | Get next queued/callback contact for dialing |
| POST | `/campaigns/:id/import` | Import CSV contacts into a campaign |
| PATCH | `/campaigns/:campaignId/members/:memberId` | Update member status (skip, callback, completed, etc.) |
| DELETE | `/campaigns/:campaignId/members/:memberId` | Remove a contact from a campaign |

### Contacts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/contacts?search=` | List contacts (optional search filter) |
| POST | `/contacts` | Create a contact |
| GET | `/contacts/:id` | Get contact detail with call history, campaigns, callbacks, DNC |
| PATCH | `/contacts/:id` | Update contact fields (businessName, contactName, email, website, address, city, state, status, doNotCall, notes) |

### Call Attempts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/call-attempts` | List call attempts |
| POST | `/call-attempts` | Create a call attempt (checks DNC before allowing) |
| PATCH | `/call-attempts/:id` | Update call attempt fields |
| POST | `/call-attempts/:id/notes` | Add a note to a call attempt |
| POST | `/call-attempts/:id/outcome` | Set call outcome, optionally flag DNC, add notes, schedule callback |

### Suppressions / DNC

| Method | Path | Description |
|--------|------|-------------|
| POST | `/suppressions/check` | Check if a phone number or contact is suppressed |
| GET | `/suppressions` | List suppression entries |
| POST | `/suppressions` | Add a suppression entry |

## Database Schema

Uses Prisma with SQLite. Key models:

- **Workspace** — tenant boundary
- **User** — authenticated user (synced from Clerk)
- **Campaign** — calling campaign with status (draft, active, paused, archived)
- **Contact** — business/person with `doNotCall` flag
- **PhoneNumber** — normalized phone numbers per workspace
- **ContactPhoneNumber** — joins contacts to phone numbers
- **CampaignMember** — joins contacts to campaigns with queue status, attempt count, callback scheduling
- **CallAttempt** — every dial attempt with status, outcome, Telnyx IDs, recording flags
- **CallNote** — notes attached to call attempts and/or contacts
- **CallbackReminder** — scheduled callbacks
- **SuppressionEntry** — DNC/bad number/wrong number blocks
- **ImportBatch / ImportRow** — CSV import tracking

Run migrations with:

```sh
npm run db:migrate
```

Open Prisma Studio to browse data:

```sh
npm run db:studio
```

## Project Structure

```
src/
  App.jsx              — Main React component (all views)
  main.jsx             — React entry point
  styles.css            — All styles
  server/
    api.js              — Express API router (all endpoints)
    auth.js             — Clerk auth middleware
    db.js               — Prisma client setup
    phone.js            — Phone number normalization (libphonenumber-js)
prisma/
  schema.prisma         — Database schema
  migrations/           — Prisma migrations
raw-leads/              — Example CSV files for import
server.js               — Express server entry point
```

## Raw Leads

The `raw-leads/` directory contains example CSV files with HVAC business leads that can be imported into campaigns. Columns: `name, phone, address, website, rating, reviews, place_id`.