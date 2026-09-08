import path from "node:path";
import { config as base } from "./wdio.conf.mjs";

export const config = {
  ...base,
  specs: ["./panels.e2e.mjs"],
  services: [
    [
      "@wdio/tauri-service",
      {
        ...base.services[0][1],
        embeddedPort: 4467,
        logDir: path.resolve("apps/desktop/native-results/panels"),
      },
    ],
  ],
  outputDir: path.resolve("apps/desktop/native-results/panels"),
};
