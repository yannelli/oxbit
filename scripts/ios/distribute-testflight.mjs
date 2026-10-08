import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";
import { createAppStoreConnectApi } from "./app-store-connect.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

export function loadTestNotes(version, buildNumber, directory = root) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !/^[1-9]\d*$/.test(buildNumber))
    throw new Error("Pass a release version and a positive integer build number");
  const file = path.join(directory, "docs/testflight", `${version}.md`);
  const body = fs.readFileSync(file, "utf8").trim();
  const notes = `Oxbit ${version.split("-")[0]} (${buildNumber}): ${body}`;
  if (!body || notes.length > 4000) throw new Error(`Testing notes must contain 1 to 4000 characters: ${file}`);
  return notes;
}

const ENCRYPTION_DESCRIPTION = "Oxbit connects to the user's own servers over SSH (russh with aws-lc) for files, Git, and remote runtimes. "
  + "It also uses HTTPS through Apple's URLSession and OpenPGP signatures for Git commits. All algorithms are industry standard.";

async function collection(api, path) {
  const entries = [];
  while (path) {
    const response = await api("GET", path);
    entries.push(...response.data);
    path = response.links?.next;
  }
  return entries;
}

/** Links a build that declares non-exempt encryption to the app's newest approved encryption declaration. */
async function assignEncryptionDeclaration(api, appId, buildId) {
  const approved = (await collection(api, `/v1/appEncryptionDeclarations?filter[app]=${appId}&limit=200`))
    .filter((entry) => entry.attributes.appEncryptionDeclarationState === "APPROVED")
    .sort((a, b) => String(b.attributes.createdDate).localeCompare(String(a.attributes.createdDate)));
  if (!approved.length)
    throw new Error("This build declares non-exempt encryption, and the app has no approved encryption declaration. Run node scripts/ios/distribute-testflight.mjs --declare-encryption once, then retry.");
  await api("POST", `/v1/appEncryptionDeclarations/${approved[0].id}/relationships/builds`, { data: [{ type: "builds", id: buildId }] });
  return approved[0].id;
}

/** Creates the app's encryption declaration: standard third-party algorithms, no proprietary cryptography, not on the French App Store. */
export async function declareEncryption({ api, identifier }) {
  const apps = await collection(api, `/v1/apps?filter[bundleId]=${encodeURIComponent(identifier)}&limit=200`);
  const app = apps.find((entry) => entry.attributes.bundleId === identifier);
  if (!app) throw new Error(`App Store Connect has no app for ${identifier}`);
  const response = await api("POST", "/v1/appEncryptionDeclarations", {
    data: { type: "appEncryptionDeclarations",
      attributes: { appDescription: ENCRYPTION_DESCRIPTION, containsProprietaryCryptography: false, containsThirdPartyCryptography: true, availableOnFrenchStore: false },
      relationships: { app: { data: { type: "apps", id: app.id } } } },
  });
  return { id: response.data.id, ...response.data.attributes };
}

export async function distributeTestFlight({
  api, identifier, version, buildNumber, notes, internal = false,
  sleep = setTimeout, now = Date.now, timeoutMs = 30 * 60_000, pollMs = 30_000,
  log = console.log,
}) {
  if (!notes.trim() || notes.length > 4000) throw new Error("Invalid TestFlight testing notes");
  const apps = await collection(api, `/v1/apps?filter[bundleId]=${encodeURIComponent(identifier)}&limit=200`);
  const app = apps.find((entry) => entry.attributes.bundleId === identifier);
  if (!app) throw new Error(`App Store Connect has no app for ${identifier}`);
  const groupName = internal ? "Internal Testing" : "Public Beta";
  const groups = (await collection(api, `/v1/apps/${app.id}/betaGroups?limit=200`))
    .filter((group) => group.attributes.name === groupName && group.attributes.isInternalGroup === internal);
  if (groups.length !== 1) throw new Error(`Expected one ${internal ? "internal" : "external"} ${groupName} group for this app`);
  const group = groups[0];
  const query = new URLSearchParams({
    "filter[app]": app.id, "filter[version]": buildNumber,
    "filter[preReleaseVersion.version]": version, "filter[preReleaseVersion.platform]": "IOS",
    include: "preReleaseVersion,buildBetaDetail", limit: "200",
  });
  const deadline = now() + timeoutMs;
  let build;
  let details;
  let declared = false;
  const waitingStates = ["PROCESSING", "IN_EXPORT_COMPLIANCE_REVIEW"];
  const stateKey = internal ? "internalBuildState" : "externalBuildState";
  while (now() < deadline) {
    const response = await api("GET", `/v1/builds?${query}`);
    const matches = response.data.filter((entry) => {
      const release = response.included?.find((item) => item.type === "preReleaseVersions" && item.id === entry.relationships?.preReleaseVersion?.data?.id);
      return entry.attributes.version === buildNumber && release?.attributes.version === version && release.attributes.platform === "IOS";
    });
    if (matches.length > 1) throw new Error("Multiple builds match the uploaded version and build number");
    build = matches[0];
    if (build?.attributes.expired) throw new Error("The uploaded TestFlight build has expired");
    const state = build?.attributes.processingState;
    details = response.included?.find((entry) => entry.type === "buildBetaDetails" && entry.id === build?.relationships?.buildBetaDetail?.data?.id);
    const missingCompliance = details?.attributes[stateKey] === "MISSING_EXPORT_COMPLIANCE";
    if (state === "VALID" && missingCompliance && build.attributes.usesNonExemptEncryption && !declared) {
      log(`Assigned encryption declaration ${await assignEncryptionDeclaration(api, app.id, build.id)} to TestFlight ${version} (${buildNumber})`);
      declared = true;
      continue;
    }
    if (state === "VALID" && details && !waitingStates.includes(details.attributes[stateKey]) && !(declared && missingCompliance)) break;
    if (build && state !== "PROCESSING" && state !== "VALID") throw new Error(`TestFlight processing failed: ${state}`);
    log(`Waiting for TestFlight ${version} (${buildNumber}): ${details?.attributes[stateKey] ?? state ?? "not visible"}`);
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  if (build?.attributes.processingState !== "VALID" || !details || waitingStates.includes(details.attributes[stateKey])
    || (declared && details.attributes[stateKey] === "MISSING_EXPORT_COMPLIANCE"))
    throw new Error("Timed out waiting for TestFlight processing");
  const buildState = details.attributes[stateKey];
  const distributable = internal
    ? ["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"]
    : ["READY_FOR_BETA_SUBMISSION", "WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW", "BETA_APPROVED", "READY_FOR_BETA_TESTING", "IN_BETA_TESTING"];
  if (!distributable.includes(buildState))
    throw new Error(`Cannot distribute TestFlight build in state ${buildState}`);
  const localizationsPath = `/v1/builds/${build.id}/betaBuildLocalizations?limit=200`;
  const localization = (await collection(api, localizationsPath)).find((entry) => entry.attributes.locale === "en-US");
  if (localization) {
    if (localization.attributes.whatsNew !== notes)
      await api("PATCH", `/v1/betaBuildLocalizations/${localization.id}`, {
        data: { type: "betaBuildLocalizations", id: localization.id, attributes: { whatsNew: notes } },
      });
  } else {
    await api("POST", "/v1/betaBuildLocalizations", {
      data: { type: "betaBuildLocalizations", attributes: { locale: "en-US", whatsNew: notes },
        relationships: { build: { data: { type: "builds", id: build.id } } } },
    });
  }
  if (!details.attributes.autoNotifyEnabled)
    await api("PATCH", `/v1/buildBetaDetails/${details.id}`, {
      data: { type: "buildBetaDetails", id: details.id, attributes: { autoNotifyEnabled: true } },
    });
  if (!internal && buildState === "READY_FOR_BETA_SUBMISSION") {
    const reviewPath = `/v1/betaAppReviewSubmissions?filter[build]=${build.id}&limit=200`;
    const accepted = (reviews) => reviews.some((entry) => ["WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED"].includes(entry.attributes.betaReviewState));
    const reviews = await collection(api, reviewPath);
    if (reviews.some((entry) => entry.attributes.betaReviewState === "REJECTED")) throw new Error("TestFlight beta review was rejected");
    if (!accepted(reviews)) {
      try {
        await api("POST", "/v1/betaAppReviewSubmissions", {
          data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } },
        });
      } catch (error) {
        if (error.status !== 409 || !accepted(await collection(api, reviewPath))) throw error;
      }
    }
  }
  const membershipPath = `/v1/betaGroups/${group.id}/relationships/builds?limit=200`;
  if (!(await collection(api, membershipPath)).some((entry) => entry.id === build.id))
    await api("POST", `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: build.id }] });
  const savedNotes = (await collection(api, localizationsPath)).find((entry) => entry.attributes.locale === "en-US");
  const membership = await collection(api, membershipPath);
  const savedDetails = (await api("GET", `/v1/builds/${build.id}/buildBetaDetail`)).data.attributes;
  if (savedNotes?.attributes.whatsNew !== notes || !membership.some((entry) => entry.id === build.id) || !savedDetails.autoNotifyEnabled)
    throw new Error(`TestFlight notes, ${groupName} assignment, or automatic notification failed verification`);
  log(`TestFlight ${version} (${buildNumber}) assigned to ${groupName}; ${stateKey}: ${savedDetails[stateKey]}`);
  return { buildId: build.id, groupId: group.id, [stateKey]: savedDetails[stateKey] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { build: { type: "string" }, "check-notes": { type: "boolean" }, internal: { type: "boolean" }, "declare-encryption": { type: "boolean" } } });
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (values["declare-encryption"]) {
    const { identifier } = JSON.parse(fs.readFileSync(path.join(root, "apps/ios/src-tauri/tauri.conf.json"), "utf8"));
    console.log(JSON.stringify(await declareEncryption({ api: createAppStoreConnectApi(), identifier })));
    process.exit(0);
  }
  const notes = loadTestNotes(version, values.build);
  if (values["check-notes"]) console.log(notes);
  else {
    const { identifier } = JSON.parse(fs.readFileSync(path.join(root, "apps/ios/src-tauri/tauri.conf.json"), "utf8"));
    await distributeTestFlight({ api: createAppStoreConnectApi(), identifier, version: version.split("-")[0], buildNumber: values.build, notes, internal: values.internal });
  }
}
