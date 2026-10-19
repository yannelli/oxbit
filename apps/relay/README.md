# Oxbit relay

Cloudflare Worker `oxbit-relay` that forwards bytes between paired devices and their host. It implements "Relay protocol (version 1)" in [`docs/remote-access.md`](../../docs/remote-access.md). Payloads are Noise messages; the relay forwards them without decrypting or storing them.

## Endpoints

| Route | Caller | Result |
| --- | --- | --- |
| `GET /health` | Anyone | `{"ok":true,"protocol":1}` |
| `GET /v1/host?id=<hostId>` | Host, WebSocket | Challenge, auth, control messages, and `[16-byte connection id][payload]` frames |
| `GET /v1/connect?id=<hostId>` | Device, WebSocket | Binary Noise messages to and from the host |

Before the upgrade the Worker answers 404 for other paths, 426 without `Upgrade: websocket`, 400 when `id` does not match `^[A-Za-z0-9_-]{22}$`, and 429 when the per-IP limiter refuses.

Each host id maps to one Durable Object `RelayHost` (`idFromName("host:" + id)`) that uses the WebSocket Hibernation API. Socket state lives in tags (`host`, `device`, `c:<connection id>`) and attachments, and one alarm covers the auth, handshake and idle deadlines. Both sockets get `pong` for the text frame `ping` from the runtime's auto-response, without waking the object.

## Limits

| Limit | Value | Enforced | Result |
| --- | --- | --- | --- |
| Host sockets per IP | 10 per 60 s | `HOST_LIMITER` binding | HTTP 429 |
| Device sockets per IP | 60 per 60 s | `CONNECT_LIMITER` binding | HTTP 429 |
| Host auth | 10 s | Alarm, and on a late `auth` | 4401 |
| Device handshake | 10 s from `open` to `established` | Alarm, and on a late frame | 4408 |
| Device idle | 10 min without binary frames | Alarm, and on a late frame | 4408 |
| Devices in the handshake | 4 | On connect | 4429 |
| Established devices | 8 | On connect and on `established` | 4429 |
| Frame | 1 MiB of payload | Each frame, both directions | 4413 |
| Bytes per host | 64 MiB per minute, 2 GiB per UTC day | Each frame, both directions | 4429 |

The rate-limit key is the IPv4 address or the IPv6 /64 prefix from `CF-Connecting-IP`; an IPv4-mapped IPv6 address counts as IPv4. Without a binding (tests), the Worker skips the check. The binding counts per Cloudflare location.

## Choices the protocol leaves open

- When the authenticated host socket closes or is replaced, its devices close with 4404. The new host never received `open` for them.
- 4408, 4413 and 4429 close the device whose deadline or frame broke the limit. The host socket stays open.
- The host gets one `{"t":"closed","c":...}` for each device socket that closes, including devices it dropped with `close` (4403).
- The frame limit counts the payload without the 16-byte connection id.
- An unauthenticated host that sends a binary frame, or text other than a valid `auth`, closes with 4401.
- `close` reasons are cut to 123 bytes of UTF-8, the WebSocket limit.
- Device text frames other than `ping` and host frames for unknown connection ids are dropped.
- The minute window lives in memory and restarts when the object hibernates. The daily count is stored under `dayCount` every 16 MiB, when a frame is refused, and on each alarm, so a wake can lose up to 16 MiB of count.

## Deploy

```sh
cd apps/relay
bun run check    # wrangler deploy --dry-run
bun run deploy   # publishes https://oxbit-relay.<account>.workers.dev
```

The rate-limit bindings use `namespace_id` `2001` and `2002`, which must be unused in the account. The route `relay.oxbit.dev` is pending the owner's approval; once approved, add `"routes": [{ "pattern": "relay.oxbit.dev", "custom_domain": true }]` to `wrangler.jsonc`.

Tests run from the repo root: `bunx vitest run apps/relay`.

## Running it locally

```sh
npx -y wrangler@4.149.0 dev --config apps/relay/wrangler.jsonc --local --port 8799
```

Checked 2026-10-19 with wrangler 4.149.0: Ed25519 auth, `ping`/`pong`, framing both ways, 4403, 4404, 4409 and the 4401 alarm work in local workerd. Two local observations:

- A server-initiated close of a hibernated socket whose client never sent a frame reaches the client (state `CLOSING`), but the connection stays open. After any frame, including `ping`, the close completes. Hosts send `auth` and devices send Noise message 1 first.
- A refused device (4404, 4429) closes normally, and the Worker logs `Network connection lost` once per refusal.

The `ratelimits` config shape (`name`, `namespace_id` as a string, `simple.limit`, `simple.period` of 10 or 60) follows the [rate-limit binding docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), checked 2026-10-19.
