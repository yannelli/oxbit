import {
  validateFileAssociations,
  validateLanguageServers,
  type Setting,
} from "@oxbit/sdk";
import schema from "./schema.json";

export const settingsConfiguration: Setting[] = [
  ...(schema as Setting[]).map((s) => ({
    ...s,
    validate:
      s.id === "files.associations"
        ? validateFileAssociations
        : s.id === "languageServers"
          ? validateLanguageServers
          : undefined,
  })),
  {
    id: "workbench.locale",
    title: "Display Language",
    type: "string",
    default: "en",
    enum: ["en", "de", "es", "ja", "zh"],
    category: "Appearance",
  },
  {
    id: "workbench.reducedMotion",
    title: "Reduced Motion",
    type: "boolean",
    default: false,
    category: "Appearance",
  },
];
