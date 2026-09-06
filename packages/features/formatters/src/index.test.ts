import { afterEach, describe, expect, it } from "vitest";
import type { FeatureOptions, Formatter, Kernel } from "@zapp/sdk";
import { createKernel } from "../../../core/src/index";
import {
  createFeature,
  createPrettierFeature,
  createTypeScriptFormatterFeature,
  FormatterService,
} from "./index";

const kernels: Kernel[] = [];
afterEach(() => {
  for (const kernel of kernels.splice(0)) kernel.dispose();
});
async function setup() {
  const kernel = createKernel();
  kernels.push(kernel);
  for (const setting of [
    {
      id: "editor.defaultFormatter",
      title: "Formatter",
      type: "string",
      default: "zapp.prettier",
    },
    { id: "editor.tabSize", title: "Tab Size", type: "number", default: 2 },
    {
      id: "editor.insertSpaces",
      title: "Spaces",
      type: "boolean",
      default: true,
    },
  ] as const)
    kernel.configuration.register(setting);
  const options = {
    kernel,
    workbench: { activePath: () => "index.ts" },
  } as FeatureOptions;
  for (const extension of [
    createFeature(options),
    createPrettierFeature(),
    createTypeScriptFormatterFeature(),
  ])
    kernel.extensions.register(extension);
  await kernel.extensions.trigger("onStartup");
  return {
    kernel,
    service: kernel.services.get<FormatterService>("formatters"),
  };
}

describe("formatter providers", () => {
  it("runs independently registered Prettier and TypeScript implementations", async () => {
    const { kernel, service } = await setup();
    expect(service.list("index.ts").map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["zapp.prettier", "zapp.builtin-ts"]),
    );
    expect(await service.format("const answer=1", "index.ts")).toBe(
      "const answer = 1;\n",
    );
    kernel.configuration.set(
      "editor.defaultFormatter",
      "zapp.builtin-ts",
      "workspace",
      "typescript",
    );
    expect(await service.format("const answer=1", "index.ts")).toBe(
      "const answer = 1",
    );
    await kernel.extensions.disable("zapp.builtin-ts");
    await expect(service.format("const answer=1", "index.ts")).rejects.toThrow(
      "unavailable",
    );
    await kernel.extensions.activate("zapp.builtin-ts");
    expect(service.list("index.ts")).toHaveLength(2);
  });
  it("consumes external contributions and language-scoped formatter options", async () => {
    const { kernel, service } = await setup();
    const formatter: Formatter = {
      id: "custom.markdown",
      languages: ["markdown"],
      format: async (text, _path, options) =>
        `${options.tabSize}:${options.insertSpaces}:${text}`,
    };
    kernel.contributions.register({
      id: "custom.formatter",
      kind: "formatter",
      title: "Custom",
      data: formatter,
    });
    kernel.configuration.set(
      "editor.defaultFormatter",
      formatter.id,
      "user",
      "markdown",
    );
    kernel.configuration.set("editor.tabSize", 4, "workspace", "markdown");
    kernel.configuration.set(
      "editor.insertSpaces",
      false,
      "workspace",
      "markdown",
    );
    expect(await service.format("Hello", "README.md")).toBe("4:false:Hello");
    expect(service.selected("index.ts").id).toBe("zapp.prettier");
  });
});
