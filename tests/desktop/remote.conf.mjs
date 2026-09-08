import { config as base } from "./wdio.conf.mjs";
export const config = { ...base, specs: ["./remote.e2e.mjs"] };
