import type { Formatter } from "@zapp/sdk";

export const formatPrettier: Formatter["format"] = async (
  text,
  path,
  options,
) => {
  options.signal?.throwIfAborted();
  const engine = await import("prettier/standalone");
  const extension = path.split(".").pop()?.toLowerCase();
  let parser: string;
  let plugins: import("prettier").Plugin[];
  if (
    ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json"].includes(
      extension ?? "",
    )
  ) {
    parser =
      extension === "json"
        ? "json"
        : ["js", "jsx", "mjs", "cjs"].includes(extension ?? "")
          ? "babel"
          : "typescript";
    plugins = [
      await import("prettier/plugins/typescript"),
      await import("prettier/plugins/babel"),
      await import("prettier/plugins/estree"),
    ];
  } else if (extension === "css") {
    parser = "css";
    plugins = [await import("prettier/plugins/postcss")];
  } else if (["html", "htm"].includes(extension ?? "")) {
    parser = "html";
    plugins = [await import("prettier/plugins/html")];
  } else if (["md", "markdown"].includes(extension ?? "")) {
    parser = "markdown";
    plugins = [await import("prettier/plugins/markdown")];
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
