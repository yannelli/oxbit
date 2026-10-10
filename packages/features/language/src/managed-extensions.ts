import { fileTypesToSelectors, languages, validateFileTypes, type ConfigurationService, type Extension, type Kernel } from "@oxbit/sdk";

const names: Record<string, string> = {
  typescript: "TypeScript / JavaScript", json: "JSON / JSONC", yaml: "YAML", dockerfile: "Dockerfile", bash: "Bash",
  basedpyright: "basedpyright", ruff: "Ruff", marksman: "Marksman", mdx: "MDX", html: "HTML", vue: "Vue", astro: "Astro",
  taplo: "Taplo", intelephense: "Intelephense", laravel: "Laravel", lemminx: "LemMinX",
};

export const managedServerIds = [...new Set(languages.flatMap(language => language.providers.filter(id => id !== "local")))];
export const managedServerExtensionId = (id: string) => `oxbit.language-${id}`;
export const managedFileTypesSetting = (id: string) => `languageServer.${id}.fileTypes`;
const serverFileTypes = (id: string) => languages.filter(language => language.providers.includes(id)).map(language => language.id);

type ServerSettings = Record<string, Record<string, unknown> | undefined>;
const userServers = (configuration: ConfigurationService) =>
  (configuration.export() as { user?: Record<string, unknown> }).user?.languageServers as ServerSettings | undefined;

/** Changes one server entry in the user layer of `languageServers`; other layers and servers stay as they are. */
function writeServer(configuration: ConfigurationService, id: string, change: (entry: Record<string, unknown>) => void) {
  const user = userServers(configuration);
  const entry = { ...user?.[id] };
  const before = JSON.stringify(entry);
  change(entry);
  if (JSON.stringify(entry) === before) return;
  const next: ServerSettings = { ...user };
  if (Object.keys(entry).length) next[id] = entry;
  else delete next[id];
  configuration.set("languageServers", next, "user");
}

function createManagedServerFeature(id: string): Extension {
  const name = names[id] ?? id;
  const setting = managedFileTypesSetting(id);
  return {
    manifest: {
      manifestVersion: 1, id: managedServerExtensionId(id), name: `${name} Language Server`, version: "1.0.0", sdk: "^1.0.0",
      description: `Runs ${name} through the Oxbit runtime. Enable state and file types map to languageServers.${id}.enabled and languageServers.${id}.selectors.`,
      environments: ["browser", "embedded"], activation: ["*"], capabilities: ["lsp"],
      configuration: [{
        id: setting, title: "File Types", category: `Language Servers · ${name}`,
        description: "Language IDs (such as python) or glob patterns (such as **/*.pyx) this server handles.",
        type: "array", items: "string", default: serverFileTypes(id), validate: validateFileTypes,
      }],
    },
    activate(ctx) {
      let explicit = ctx.configuration.inspect(setting).explicit;
      ctx.subscribe(ctx.configuration.subscribe(() => {
        const current = ctx.configuration.inspect<string[]>(setting);
        if (!current.explicit && !explicit) return;
        explicit = current.explicit;
        writeServer(ctx.configuration, id, entry => {
          if (current.explicit) entry.selectors = fileTypesToSelectors(current.value);
          else delete entry.selectors;
        });
      }));
    },
  };
}

/** Registers one extension per runtime-managed server; disabling one writes `languageServers.<id>.enabled: false`. */
export async function registerManagedServerFeatures(kernel: Kernel, disabled: readonly string[]): Promise<void> {
  for (const id of managedServerIds) kernel.extensions.register(createManagedServerFeature(id));
  kernel.events.on("extension.change", ({ id, state }: { id: string; state: string }) => {
    const server = managedServerIds.find(server => managedServerExtensionId(server) === id);
    if (!server || state !== "disabled" && state !== "active") return;
    writeServer(kernel.configuration, server, entry => {
      if (state === "disabled") entry.enabled = false;
      else if (entry.enabled === false) delete entry.enabled;
    });
  });
  const saved = userServers(kernel.configuration) ?? {};
  for (const id of managedServerIds) {
    const extension = managedServerExtensionId(id);
    if (disabled.includes(extension) || saved[id]?.enabled === false) await kernel.extensions.disable(extension);
    else await kernel.extensions.activate(extension);
  }
}
