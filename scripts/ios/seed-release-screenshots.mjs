import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sample = join(root, "design/releases/v0.3.1/sample-workspace/Fieldnotes");
const devices = {
  iphone: {
    id: "90217232-2528-4353-91B1-545C7A45D429",
    name: "Oxbit Release 0.3.1 iPhone",
  },
  ipad: {
    id: "D5DD45DB-C016-4E50-B022-BC5309B869AC",
    name: "Oxbit Release 0.3.1 iPad",
  },
};

const selected = process.argv[2];
if (!Object.hasOwn(devices, selected)) {
  throw new Error("Choose iphone or ipad");
}

const device = devices[selected];
const inventory = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" }));
const found = Object.values(inventory.devices).flat().find((item) => item.udid === device.id);
if (found?.name !== device.name || found.state !== "Booted") {
  throw new Error(`Boot the task-owned ${device.name} simulator first`);
}

const container = execFileSync("xcrun", ["simctl", "get_app_container", device.id, "com.yannelli.oxbit", "data"], { encoding: "utf8" }).trim();
const expected = resolve(process.env.HOME, "Library/Developer/CoreSimulator/Devices", device.id, "data/Containers/Data/Application");
if (!resolve(container).startsWith(expected + "/")) {
  throw new Error(`Unexpected app container: ${container}`);
}

const destination = join(container, "Documents/Fieldnotes");
if (existsSync(destination)) {
  throw new Error(`Sample project already exists: ${destination}`);
}
const sessionFile = join(container, "Library/Application Support/com.yannelli.oxbit/session.json");
const session = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8")) : {};
if (Object.keys(session).length) {
  throw new Error(`Existing session requires manual review: ${sessionFile}`);
}
cpSync(sample, destination, { recursive: true });
session.recents = [{
  id: "documents:Fieldnotes",
  kind: "documents",
  name: "Fieldnotes",
  directory: "Fieldnotes",
  lastOpened: Date.now(),
}];
session["last-workspace"] = "documents:Fieldnotes";
mkdirSync(dirname(sessionFile), { recursive: true });
writeFileSync(sessionFile, JSON.stringify(session));
console.log(`Seeded ${device.name}: ${destination}`);
