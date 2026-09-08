import type { Extension, Kernel } from "@oxbit/sdk";
import { classicOS98Themes } from "./bundled.js";
import { classicOS98IconPack } from "./classicos98/index.js";

const [fileTheme, controls, controlsDark] = classicOS98IconPack.themes;

/** The bundled control glyphs are black-outlined, so a dark face needs the inverted set. */
function selectedMode(kernel: Kernel) {
  const id = kernel.configuration.get<string>("workbench.colorTheme");
  const selected = kernel.contributions
    .list("theme")
    .find(
      (theme) =>
        theme.id === id ||
        theme.title === id ||
        (theme.data as { stableId?: string })?.stableId === id,
    );
  return (selected?.data as { mode?: "light" | "dark" })?.mode ?? "dark";
}

export function createClassicOS98Feature({
  kernel,
}: {
  kernel: Kernel;
}): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.themes-classicos98",
      name: "ClassicOS 98",
      description:
        "Windows 98 and 2000 era desktop styling: the grey 3D workbench, Eggplant and High Contrast Black schemes, and matching 16x16 VGA icons.",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      contributions: classicOS98Themes,
    },
    activate(ctx) {
      for (const theme of classicOS98Themes)
        ctx.own(
          ctx.commands.register({
            id: `theme.${theme.id.replace("oxbit.", "")}`,
            title: `Use ${theme.title}`,
            category: "Preferences",
            run: () =>
              kernel.configuration.set(
                "workbench.colorTheme",
                theme.data.stableId,
              ),
          }),
        );
      ctx.own(
        ctx.commands.register({
          id: "theme.classicos98.apply",
          title: "Use ClassicOS 98 Theme and Icons",
          category: "Preferences",
          run: () => {
            const dark = selectedMode(kernel) === "dark";
            const theme = classicOS98Themes.find(
              (item) => (item.data.mode === "dark") === dark,
            )!;
            kernel.configuration.set(
              "workbench.colorTheme",
              theme.data.stableId,
            );
            kernel.configuration.set("workbench.iconTheme", fileTheme.id);
            kernel.configuration.set(
              "workbench.productIconTheme",
              dark ? controlsDark.id : controls.id,
            );
          },
        }),
      );
    },
  };
}
