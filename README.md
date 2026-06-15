# Telnyx Browser Dialer

Minimal browser dialer for Ubuntu/Chrome using the official `@telnyx/webrtc` JavaScript SDK.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create your environment file:

   ```sh
   cp .env.example .env
   ```

3. Set Telnyx auth in `.env`.

   Prefer `TELNYX_LOGIN_TOKEN` with a Telnyx WebRTC JWT/login token. As a fallback, set `TELNYX_SIP_USERNAME` and `TELNYX_SIP_PASSWORD` for a SIP/WebRTC credential. The fallback credentials are not hardcoded in the frontend, but the browser still receives them at runtime because the Telnyx SDK authenticates from the browser.

4. Optionally set `TELNYX_CALLER_NUMBER` to your Telnyx caller ID in E.164 format.

## Run

```sh
npm run dev
```

Open `http://127.0.0.1:3400` in Chrome, enter the destination number in E.164 format such as `+15551234567`, then click `Dial`. The first dial attempt asks for microphone access and connects to Telnyx automatically before placing the call.

## Production Build

```sh
npm run build
NODE_ENV=production npm run preview
```
