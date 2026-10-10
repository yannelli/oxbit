import { config as base } from "./wdio.conf.mjs";

export const config = { ...base, specs: ["./agent.e2e.mjs"] };
