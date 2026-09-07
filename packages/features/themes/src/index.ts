import type { Extension, Kernel } from "@oxbit/sdk";
export function createFeature({ kernel }: { kernel: Kernel }): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.themes",
      name: "Graphite and Paper",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      contributions: [
        {
          id: "oxbit.graphite",
          kind: "theme",
          title: "Graphite (dark)",
          data: { mode: "dark" },
        },
        {
          id: "oxbit.paper",
          kind: "theme",
          title: "Paper (light)",
          data: { mode: "light" },
        },
      ],
    },
    activate(ctx) {
      ctx.own(
        ctx.commands.register({
          id: "theme.toggle",
          title: "Toggle Light/Dark Theme",
          category: "Preferences",
          shortcut: "Ctrl+K Ctrl+T",
          run: () =>
            kernel.configuration.set(
              "workbench.colorTheme",
              kernel.configuration.get("workbench.colorTheme") ===
                "Paper (light)"
                ? "Graphite (dark)"
                : "Paper (light)",
            ),
        }),
      );
    },
  };
}
