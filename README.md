# Kazushiki Combat AI API

Cloudflare Worker for AI Coach chat and **monthly AI video reviews**.

## Quota contract

- Free Apple Account: **1 successful AI video review per UTC calendar month**.
- Verified Combat Pro subscription: **10 successful AI video reviews per UTC calendar month**.
- Both paid plans share the same 10-review allowance (not 10 for each plan).
- Video credits reset at 00:00 UTC on the first day of every calendar month.
- `POST /ai/video-quota`: read remaining credits, requires signed StoreKit proof.
- `POST /ai/video-review`: atomically reserves 1 credit before calling Gemini/OpenAI, refunds it when every provider fails.
- `POST /ai/chat`: unchanged (iOS app keeps AI chat behind Pro).
- `GET /health` or `GET /ping`: health checks.

Both video endpoints take two JSON properties alongside the existing video fields:

```json
{
  "appTransactionJWS": "<StoreKit AppTransaction.shared signed JWS>",
  "subscriptionJWS": "<optional active StoreKit transaction JWS>"
}
```

Never trust an unsigned `isPro` boolean or client-provided usage counters.
The backend verifies Apple's signing chain, app bundle ID, production Apple app ID,
the app-transaction identity, product ID, expiry, and revocation.
It stores one D1 usage row per signed Apple Account app-transaction ID and month.
Production is the default; sandbox transactions are refused unless explicitly enabled.
Users need no sign-in. Download identities persist across reinstall according to Apple.

## One-time setup (required before deployment)

1. `npm install` in this repository. The official Apple App Store Server library is required.
2. Create a D1 database: `npx wrangler d1 create kazushiki-video-quota`.
3. Replace `REPLACE_WITH_CLOUDFLARE_D1_ID` in `wrangler.toml` with the returned `database_id`.
4. Initialize database:

   `npx wrangler d1 execute kazushiki-video-quota --remote --file=./migrations/0001_video_review_quota.sql`

5. From [Apple PKI](https://www.apple.com/certificateauthority/), download the authentic **Apple Root CA - G3** DER certificate. Base64 encode its bytes and store the value using `npx wrangler secret put APPLE_ROOT_CA_BASE64`. On PowerShell:
   `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AppleRootCA-G3.cer")) | npx wrangler secret put APPLE_ROOT_CA_BASE64`
6. The public app Apple ID `6818292330` is already set as `APP_APPLE_ID` in `wrangler.toml`. Confirm it matches App Store Connect when deploying.
7. Keep existing `OPENAI_API_KEY` / `GEMINI_API_KEY` secrets configured.
8. Only on a test/staging worker, optionally set `ALLOW_SANDBOX_IAP` to `true` to test TestFlight/StoreKit sandbox purchases. Keep it disabled on your production worker.
9. Test free allowance (1 -> 0 -> 429), Pro allowance (10 -> 0 -> 429), failed review refund, and fresh month rollover **in staging**, then deploy.
10. Confirm the shipped iOS build injects `EXPO_PUBLIC_RORK_FUNCTIONS_URL` in `Config.allValues`, pointing to THIS configured worker. The committed `Config.swift` has an empty placeholder, so verify the release build configuration before shipping.

## Release caveats

- **Never deploy** the code without D1 migration, public Apple ID config, and the Apple certificate secret; unconfigured quota routes fail closed.
- App Store Connect must contain the exact monthly/yearly subscription product IDs and both must be submitted for Apple's first review. This is independent of implementing video caps.
- This deliberately uses Apple's signed download identity instead of introducing a login system. Replayed JWS proof consumes the same account quota, although strong device-bound anti-sharing enforcement (App Attest) can be a later improvement if abuse appears.
- Quota covers **video analysis only**, not Pro AI Coach chat.
