import { mkdir, copyFile } from "node:fs/promises";
await mkdir("apps/web/public/extensions", { recursive: true });
await copyFile(
  "examples/bundle-inspector/dist/bundle-inspector.js",
  "apps/web/public/extensions/bundle-inspector.js",
);
await copyFile(
  "examples/bundle-inspector/dist/bundle-inspector.js.map",
  "apps/web/public/extensions/bundle-inspector.js.map",
);
