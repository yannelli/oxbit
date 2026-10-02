import crypto from "node:crypto";
import fs from "node:fs";

// Prints one more than the highest build number App Store Connect holds for the app.
const { APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH } = process.env;
for (const [name, value] of Object.entries({ APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH }))
  if (!value) throw new Error(`Set ${name}`);
const identifier = JSON.parse(
  fs.readFileSync(new URL("../../apps/ios/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).identifier;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${encode({ alg: "ES256", kid: APPLE_API_KEY, typ: "JWT" })}.${encode({ iss: APPLE_API_ISSUER, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
const signature = crypto
  .sign("sha256", Buffer.from(unsigned), { key: fs.readFileSync(APPLE_API_KEY_PATH), dsaEncoding: "ieee-p1363" })
  .toString("base64url");
async function api(path) {
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${unsigned}.${signature}` },
  });
  if (!response.ok) throw new Error(`App Store Connect ${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
const app = (await api(`apps?filter[bundleId]=${identifier}&fields[apps]=bundleId`)).data.find(
  (entry) => entry.attributes.bundleId === identifier,
);
if (!app) throw new Error(`App Store Connect has no app for ${identifier}`);
const builds = await api(`builds?filter[app]=${app.id}&sort=-uploadedDate&limit=200&fields[builds]=version`);
const numbers = builds.data.map((build) => Number.parseInt(build.attributes.version, 10)).filter(Number.isFinite);
console.log(Math.max(0, ...numbers) + 1);
