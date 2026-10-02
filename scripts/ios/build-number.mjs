import fs from "node:fs";
import { createAppStoreConnectApi } from "./app-store-connect.mjs";

// Prints one more than the highest build number App Store Connect holds for the app.
const api = createAppStoreConnectApi();
const identifier = JSON.parse(
  fs.readFileSync(new URL("../../apps/ios/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).identifier;
const app = (await api("GET", `/v1/apps?filter[bundleId]=${identifier}&fields[apps]=bundleId`)).data.find(
  (entry) => entry.attributes.bundleId === identifier,
);
if (!app) throw new Error(`App Store Connect has no app for ${identifier}`);
const builds = await api("GET", `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=200&fields[builds]=version`);
const numbers = builds.data.map((build) => Number.parseInt(build.attributes.version, 10)).filter(Number.isFinite);
console.log(Math.max(0, ...numbers) + 1);
