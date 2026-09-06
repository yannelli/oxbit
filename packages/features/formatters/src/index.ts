import {
  languageIdForPath,
  type Contribution,
  type Extension,
  type FeatureOptions,
  type Formatter,
} from "@zapp/sdk";
export {
  createPrettierFeature,
  createTypeScriptFormatterFeature,
} from "./provider";

export class FormatterService {
  readonly providers = new Map<string, Formatter>();
  constructor(private readonly options: FeatureOptions) {}
  register(formatter: Formatter) {
    if (this.providers.has(formatter.id))
      throw new Error(`Duplicate formatter ${formatter.id}`);
    this.providers.set(formatter.id, formatter);
    let disposed = false;
    return {
      dispose: () => {
        if (!disposed) {
          disposed = true;
          this.providers.delete(formatter.id);
        }
      },
    };
  }
  list(path?: string): Formatter[] {
    const providers = new Map(this.providers);
    for (const contribution of this.options.kernel.contributions.list(
      "formatter",
    )) {
      const provider = contribution.data as Formatter | undefined;
      if (
        !provider ||
        typeof provider.id !== "string" ||
        typeof provider.format !== "function" ||
        !Array.isArray(provider.languages)
      )
        continue;
      if (providers.has(provider.id) && providers.get(provider.id) !== provider)
        throw new Error(`Duplicate formatter ${provider.id}`);
      providers.set(provider.id, provider);
    }
    const language = path ? languageIdForPath(path) : undefined;
    return [...providers.values()].filter(
      (provider) => !language || provider.languages.includes(language),
    );
  }
  selected(path: string): Formatter {
    const language = languageIdForPath(path);
    const id =
      this.options.kernel.configuration.get<string>(
        "editor.defaultFormatter",
        language,
      ) || "zapp.prettier";
    const formatter = this.list(path).find((provider) => provider.id === id);
    if (!formatter)
      throw new Error(`Formatter ${id} is unavailable for ${language}`);
    return formatter;
  }
  title(path: string): string {
    const formatter = this.selected(path);
    return (
      this.options.kernel.contributions
        .list("formatter")
        .find(
          (contribution: Contribution) =>
            (contribution.data as Formatter)?.id === formatter.id,
        )?.title ?? formatter.id
    );
  }
  async format(
    text: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const language = languageIdForPath(path);
    const formatter = this.selected(path);
    const result = await formatter.format(text, path, {
      tabSize:
        this.options.kernel.configuration.get<number>(
          "editor.tabSize",
          language,
        ) ?? 2,
      insertSpaces:
        this.options.kernel.configuration.get<boolean>(
          "editor.insertSpaces",
          language,
        ) ?? true,
      signal,
    });
    signal?.throwIfAborted();
    return result;
  }
}

export function createFeature(options: FeatureOptions): Extension {
  return {
    manifest: {
      manifestVersion: 1,
      id: "zapp.formatters",
      name: "Formatter coordination",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
    },
    activate(ctx) {
      const service = new FormatterService(options);
      ctx.services.register("formatters", service);
      const refresh = () => {
        const path = options.workbench.activePath();
        let available = false;
        if (path) {
          try {
            service.selected(path);
            available = true;
          } catch {}
        }
        if (ctx.context.get("formattable") !== available)
          ctx.context.set("formattable", available);
      };
      ctx.configuration.subscribe(refresh);
      ctx.contributions.subscribe(refresh);
      ctx.events.on("editor.active", refresh);
      refresh();
      ctx.commands.register({
        id: "editor.format",
        title: "Format Document",
        shortcut: "Mod+Shift+I",
        when: "editor && formattable",
        run: async () => {
          const path = options.workbench.activePath();
          if (!path) throw new Error("Open a document to format");
          const document = await options.documents.open(path);
          const version = document.version,
            started = performance.now(),
            title = service.title(path);
          const text = await service.format(
            document.text.toString(),
            path,
            ctx.signal,
          );
          if (document.version !== version)
            throw new Error("Document changed during formatting");
          document.replace(text);
          options.workbench.notify(
            `Formatted with ${title} · ${Math.round(performance.now() - started)} ms`,
          );
        },
      });
      ctx.hooks.beforeSave(
        "formatters.save",
        async ({ path, text, signal }) => {
          const language = languageIdForPath(path);
          if (ctx.configuration.get("editor.formatOnSave", language))
            text = await service.format(text, path, signal);
          signal.throwIfAborted();
          if (ctx.configuration.get("files.trimTrailingWhitespace", language))
            text = text.replace(/[\t ]+$/gm, "");
          return text;
        },
        10,
      );
      ctx.subscribe(() => ctx.context.set("formattable", false));
    },
  };
}
