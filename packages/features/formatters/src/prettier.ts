import { resolveLanguage } from "@oxbit/sdk";
import type { Formatter } from "@oxbit/sdk";

export const formatPrettier: Formatter["format"] = async (
  text,
  path,
  options,
) => {
  options.signal?.throwIfAborted();
  const engine = await import("prettier/standalone");
  const language = options.language ?? resolveLanguage(path).id;
  let parser: string;
  let plugins: import("prettier").Plugin[];
  if (
    ["typescript", "typescriptreact", "javascript", "javascriptreact", "json"].includes(
      language,
    )
  ) {
    parser =
      language === "json"
        ? "json"
        : ["javascript", "javascriptreact"].includes(language)
          ? "babel"
          : "typescript";
    plugins = [
      await import("prettier/plugins/typescript"),
      await import("prettier/plugins/babel"),
      await import("prettier/plugins/estree"),
    ];
  } else if (language === "css") {
    parser = "css";
    plugins = [await import("prettier/plugins/postcss")];
  } else if (["html"].includes(language)) {
    parser = "html";
    plugins = [await import("prettier/plugins/html")];
  } else if (["markdown", "mdx"].includes(language)) {
    parser = language;
    plugins = [await import("prettier/plugins/markdown"), await import("prettier/plugins/babel"), await import("prettier/plugins/estree")];
  } else throw new Error(`Prettier does not support ${path}`);
  const result = await engine.format(text, {
    parser,
    plugins,
    tabWidth: options.tabSize,
    useTabs: !options.insertSpaces,
  });
  options.signal?.throwIfAborted();
  return result;
};
