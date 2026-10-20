# Remote access

Created: 2026-10-19. Last updated: 2026-10-19.

Remote access lets a paired iPhone or iPad open folders on a computer from any network, without an account. One host process per computer (`oxbit remote`) holds the computer's keys, the paired devices, a connection to the relay, and a folder browser. It starts one runtime per folder through the same path as `oxbit [path]` and forwards each project session to that runtime. Runtime authentication, grants and trust are unchanged.

The relay (`apps/relay`, Cloudflare Worker `oxbit-relay`) forwards encrypted bytes between a device and its host. It cannot read them: devices and hosts run a Noise handshake end to end. The relay sees IP addresses, timing and message sizes.

## Setup

On the computer:

```sh
oxbit remote enable     # start the host now and at login, then show a pairing link
oxbit remote pair       # show a new pairing link (single use, expires after 2 minutes)
oxbit remote status     # host id, relay connection, LAN address, paired devices
oxbit remote devices    # paired devices with last-seen times
oxbit remote revoke <device>
oxbit remote disable    # stop the host and remove the login item; keys and devices stay
oxbit remote reset      # new host keys; every device must pair again
```

Each command takes `--json` and prints one JSON object per line; the desktop app drives the host this way. `oxbit remote enable --no-service` skips the login item; run `oxbit remote serve` yourself. A folder named `remote` opens with `oxbit ./remote`.

On the device, open the pairing link: scan the QR code with the Camera app, or paste the link into Oxbit's Runtime page. The computer then appears under Runtimes. On the same network the device connects directly over the LAN; elsewhere it connects through the relay. A sleeping computer shows as offline with its last-seen time; the relay cannot wake it.

## Identities

| Item | Value |
| --- | --- |
| Host admission key | Ed25519 key pair. The relay admits a host connection only after a signature by this key. |
| Host static key | X25519 key pair, the responder static key in Noise. |
| Host id | `base64url(SHA-256(raw Ed25519 public key))`, first 22 characters. The relay names one Durable Object per host id. |
| Device key | X25519 key pair, the initiator static key in Noise. Stored in the iOS Keychain, or `0600` on a computer. |
| Device id | `base64url(raw device X25519 public key)`. |

`base64url` is RFC 4648 section 5 without padding everywhere in this document.

## Pairing link

`https://oxbit.dev/c#o=<offer>` or `oxbit://c#o=<offer>`, where `<offer>` is `base64url(UTF-8 JSON)`:

| Field | Value |
| --- | --- |
| `v` | `1` |
| `h` | Host id |
| `e` | Host Ed25519 public key; the device checks that it hashes to `h` |
| `x` | Host X25519 public key |
| `o` | Offer id, 8 random bytes |
| `k` | Pre-shared key, 32 random bytes |
| `r` | Relay base URL, `wss://relay.oxbit.dev` by default |
| `n` | Host display name |
| `l` | Optional LAN addresses, `host:port` |

The offer is in the URL fragment, so browsers and the website never send it to a server. The host keeps pending offers in memory, accepts each one once, and drops it after 2 minutes.

## Relay protocol (version 1)

`GET /health` answers `{"ok":true,"protocol":1}`.

### Host socket: `GET /v1/host?id=<hostId>` (WebSocket)

Text frames are JSON control messages:

| Direction | Message |
| --- | --- |
| relay to host | `{"t":"challenge","nonce":"<32 bytes>"}`, sent on accept |
| host to relay | `{"t":"auth","key":"<Ed25519 public key>","sig":"<signature>"}` where the signed bytes are UTF-8 `oxbit-relay-v1:<hostId>:<nonce>` |
| relay to host | `{"t":"ready"}` once the key hashes to the host id and the signature verifies |
| relay to host | `{"t":"open","c":"<connection id>"}` when a device connects |
| relay to host | `{"t":"closed","c":"<connection id>"}` when a device socket closes |
| host to relay | `{"t":"established","c":"<connection id>"}` after the Noise handshake succeeds |
| host to relay | `{"t":"close","c":"<connection id>","reason":"<text>"}` to drop a device; the relay closes that socket with 4403 |

Binary frames are `[16-byte connection id][payload]` in both directions. A connection id is 16 random bytes, written in JSON as base64url. A host that has not authenticated within 10 seconds is closed with 4401. An authenticated host replaces an earlier host socket for the same id, which is closed with 4409.

### Device socket: `GET /v1/connect?id=<hostId>` (WebSocket)

Binary frames carry Noise messages. The relay forwards each one to the host with the connection id prefix and sends host payloads for that id back unchanged. When no host is connected, the relay accepts and then closes with 4404.

Both sockets answer the text frame `ping` with `pong` without waking the Durable Object.

### Close codes

| Code | Meaning |
| --- | --- |
| 4401 | Host did not authenticate |
| 4403 | Host dropped the device (reason from the host: `unknown-device`, `offer-expired`, `revoked`, `bad-handshake`, `host-stopping`) |
| 4404 | Host offline |
| 4408 | Handshake not finished in 10 seconds, or 10 minutes without binary traffic |
| 4409 | Replaced by a newer host socket |
| 4413 | Frame larger than 1 MiB |
| 4429 | Rate or byte limit reached |

### Limits

| Scope | Limit |
| --- | --- |
| Per IP (IPv6 counted per /64), Workers rate-limit binding | 10 host sockets per 60 s, 60 device sockets per 60 s |
| Per host | 8 established devices, 4 devices still in the handshake, 64 MiB per minute, 2 GiB per UTC day |
| Per frame | 1 MiB |

Mobile carriers share addresses across many phones, so the device-side per-IP limit is loose on purpose. The Workers rate-limit binding counts per Cloudflare location.

## Local network path

The host also listens on its LAN addresses at `remote.json` `lanPort` and advertises the Bonjour service `_oxbit-remote._tcp` with TXT records `id=<hostId>`, `name`, `version` and `port`. `ws://<address>:<port>/v1/connect` carries the same binary frames as the relay's device socket, without the connection id prefix. A device tries a Bonjour address for its host first, then the offer's `l` addresses, then the relay. The Noise handshake is the same on every path.

## Tunnel (version 1)

The device is the Noise initiator and the host is the responder. Both use the prologue `oxbit-tunnel-v1`.

| Situation | Protocol name |
| --- | --- |
| First pairing | `Noise_IKpsk2_25519_AESGCM_SHA256` with the offer's `k` |
| Paired device | `Noise_IK_25519_AESGCM_SHA256` |

Handshake frames are WebSocket binary messages:

1. Device to host: `[mode byte][Noise message 1]`, mode `0x01` for IK and `0x02` for IKpsk2. Payload: UTF-8 JSON `{"v":1,"name":"<device name>","offer":"<offer id>"}`, with `offer` only in IKpsk2.
2. Host to device: `[Noise message 2]`. Payload: UTF-8 JSON `{"v":1,"id":"<host id>","name":"<host name>"}`.

In IK mode, the host rejects a device static key that is not in its device list. In IKpsk2 mode, the host looks up the offer id and uses its key. A wrong key only shows when the first transport message from the device fails to decrypt, so the host adds the device to its list and deletes the offer after that first message decrypts.

After the handshake, each binary message is one Noise transport message of at most 65535 bytes. Its plaintext is a frame:

```
[stream: uint32 big-endian][flags: uint8][payload]
```

| Flag | Meaning |
| --- | --- |
| `0x01` FIN | Last fragment of a message; the receiver joins the fragments and decodes UTF-8 |
| `0x02` CLOSE | The stream ended; the payload is a UTF-8 reason |

Senders split messages into payloads of at most 65000 bytes.

### Control stream (stream 0)

Messages are JSON. Requests are `{"id":"<id>","method":"<name>","params":{}}`; responses are `{"id":"<id>","result":...}` or `{"id":"<id>","error":{"code":"<code>","message":"<text>"}}`. Host events are `{"event":"<name>","params":{}}`.

| Method | Params | Result |
| --- | --- | --- |
| `host.info` | none | `{id, name, version, platform, home}` |
| `host.list` | `{path}` | `{path, parent?, entries: [{name, kind: "directory" \| "file"}], truncated?}`; hidden entries are left out, directories come first, and `truncated` is set past 2000 entries |
| `host.projects` | none | `{projects: [{path, name, running, lastOpened?}]}` |
| `host.open` | `{path}` | `{stream, token, runtime: {id, name, version}, workspace: {root, name}}` |
| `host.close` | `{stream}` | `{}` |

| Event | Params |
| --- | --- |
| `stream.closed` | `{stream, reason}` |

`host.open` starts or reuses the folder's runtime on loopback, pairs with it using the code in its `daemon.json`, and returns a session token. Messages on the returned stream are runtime protocol messages, the same JSON that crosses the runtime's `/ws` socket. The device's first message is `auth.authenticate {token}`.

`host.list` and `host.open` accept paths inside the user's home folder, except these hidden paths: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/Library/Keychains`, `~/.oxbit`. Dot-prefixed entries are hidden in listings. A device with terminal access in a trusted folder can still reach the whole account.

## Host files

The host keeps its state in `~/.oxbit/remote/` (directory `0700`, files `0600`):

| File | Contents |
| --- | --- |
| `host.json` | Version, host id, Ed25519 and X25519 key pairs (PKCS #8 and raw public keys, base64url) |
| `devices.json` | `[{id, name, pairedAt, lastSeen}]` |
| `remote.json` | `{relay, lanPort}`; `lanPort` 0 picks a free port at each start |
| `projects.json` | Folders opened through the host, for `host.projects` |
| `ctl.sock` | Unix socket the `oxbit remote` commands use to reach the running host |
| `remote.log` | Host output, without offer keys or tokens |

The login item is a launchd agent `dev.oxbit.remote` on macOS and a systemd user unit `oxbit-remote.service` on Linux.

## Development

| Check | Command |
| --- | --- |
| Tunnel library and Noise test vectors | `bunx vitest run packages/sdk/src/tunnel` |
| Relay Worker | `bunx vitest run apps/relay`, `bun run --cwd apps/relay check` |
| Host | `bunx vitest run apps/runtime/tests/remote` |
| Device client and iOS | `bunx vitest run packages/host-runtime apps/ios`, `bun run ios:check` |
| End to end | `bun run remote-access:e2e` builds the runtime, starts the relay with `wrangler dev --local`, runs `oxbit remote serve` with a temporary home folder, and pairs, opens a folder, reconnects and revokes a device through the relay |

`OXBIT_RELAY` points the host at another relay, and `OXBIT_REMOTE_DIR` moves the host state. The relay README covers deployment; the `relay.oxbit.dev` route is not set up yet.

## References

- [The Noise Protocol Framework, revision 34](https://noiseprotocol.org/noise.html): handshake patterns, the `psk2` modifier, AES-GCM nonces and `Split()`.
- [Cacophony test vectors](https://github.com/haskell-cryptography/cacophony), as packaged by [snow](https://github.com/mcginty/snow/blob/main/tests/vectors/cacophony.txt): the `IK` and `IKpsk2` vectors in `packages/sdk/src/tunnel/cacophony-vectors.json`.
- [Durable Objects WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/): the relay's sockets and per-IP limits.
- [Supporting associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains): the `apple-app-site-association` file at `website/public/.well-known/`.
