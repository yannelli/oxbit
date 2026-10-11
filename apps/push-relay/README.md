# Oxbit push relay

Cloudflare Worker `oxbit-push` that holds the APNs key and sends pushes for the iOS app. The request and response types are in `packages/sdk/src/push.ts`.

## Endpoints

| Route | Caller | Result |
| --- | --- | --- |
| `POST /v1/devices` | iOS WebView (CORS open) | `{handle}`: the token, environment and kind sealed with AES-GCM |
| `POST /v1/push` | Runtime | `{sent: true}` on APNs 200 |

`/v1/push` answers HTTP 200 with `{sent: false, gone: true, reason}` when APNs reports the token gone (410, or 400 `BadDeviceToken` / `Unregistered`). Drop the handle in that case. Other failures carry `{sent: false, reason}` with status 400 (bad handle or payload), 413 (body over 4 KB), 502 (APNs error) or 503 (secrets missing).

## Secrets

| Name | Value |
| --- | --- |
| `HANDLE_SECRET` | Base64 of 32 random bytes: `openssl rand -base64 32`. Changing it invalidates every handle. |
| `APNS_KEY` | Contents of the `AuthKey_<KEY_ID>.p8` file |
| `APNS_KEY_ID` | The key's 10-character ID |
| `APNS_TEAM_ID` | The Apple Developer team ID |

`BUNDLE_ID` is a plain var in `wrangler.jsonc`.

```sh
cd apps/push-relay
npx -y wrangler@4.149.0 secret put HANDLE_SECRET
npx -y wrangler@4.149.0 secret put APNS_KEY < AuthKey_XXXXXXXXXX.p8
npx -y wrangler@4.149.0 secret put APNS_KEY_ID
npx -y wrangler@4.149.0 secret put APNS_TEAM_ID
```

## Deploy

```sh
cd apps/push-relay
bun run check    # wrangler deploy --dry-run
bun run deploy   # publishes https://oxbit-push.<account>.workers.dev
```

Tests run from the repo root: `bunx vitest run apps/push-relay`.
