import type { Setting } from "@oxbit/sdk";

export const desktopConfiguration: Setting[] = [
  {
    id: "desktop.projects.openBehavior",
    title: "Open projects",
    category: "Desktop",
    type: "string",
    default: "currentWindow",
    enum: ["currentWindow", "newWindow"],
  },
  ...["git", "gh"].map((tool) => ({
    id: `desktop.tools.${tool}Path`,
    title: `${tool} executable path`,
    category: "Desktop",
    type: "string" as const,
    default: "",
  })),
];
