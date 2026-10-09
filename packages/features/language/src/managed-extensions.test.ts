import { describe, expect, it } from "vitest";
import { createKernel } from "../../../core/src/index";
import { managedServerIds, registerManagedServerFeatures } from "./managed-extensions";

async function setup(user: Record<string, unknown> = {}, disabled: string[] = []) {
  const kernel = createKernel();
  kernel.configuration.register({ id: "languageServers", title: "Language Servers", type: "object", default: {} });
  kernel.configuration.import({ user: { languageServers: user } });
  await registerManagedServerFeatures(kernel, disabled);
  const servers = () => (kernel.configuration.export() as any).user.languageServers;
  const state = (id: string) => kernel.extensions.list().find(record => record.manifest.id === `oxbit.language-${id}`)?.state;
  return { kernel, servers, state };
}

describe("managed language server extensions", () => {
  it("registers one extension per managed server, including YAML and Python servers", async () => {
    const { kernel, state } = await setup();
    expect(managedServerIds).toEqual(expect.arrayContaining(["typescript", "json", "yaml", "dockerfile", "bash", "basedpyright", "ruff"]));
    expect(managedServerIds).not.toContain("local");
    for (const id of managedServerIds) expect(state(id)).toBe("active");
    expect(kernel.configuration.get("languageServer.basedpyright.fileTypes")).toEqual(["python"]);
    kernel.dispose();
  });

  it("maps enable state to languageServers.<id>.enabled in both directions", async () => {
    const { kernel, servers, state } = await setup({ bash: { enabled: false, priority: 2 } }, ["oxbit.language-ruff"]);
    expect(state("bash")).toBe("disabled");
    expect(state("ruff")).toBe("disabled");
    expect(servers()).toEqual({ bash: { enabled: false, priority: 2 }, ruff: { enabled: false } });
    await kernel.extensions.activate("oxbit.language-bash");
    await kernel.extensions.activate("oxbit.language-ruff");
    expect(servers()).toEqual({ bash: { priority: 2 } });
    await kernel.extensions.disable("oxbit.language-yaml");
    expect(servers().yaml).toEqual({ enabled: false });
    kernel.dispose();
  });

  it("writes file types to languageServers.<id>.selectors and removes them on reset", async () => {
    const { kernel, servers } = await setup({ yaml: { selectors: [{ language: "yaml" }] } });
    expect(servers().yaml).toEqual({ selectors: [{ language: "yaml" }] });
    kernel.configuration.set("languageServer.yaml.fileTypes", ["yaml", "**/*.yaml.tmpl"]);
    expect(servers().yaml).toEqual({ selectors: [{ language: "yaml" }, { pattern: "**/*.yaml.tmpl" }] });
    kernel.configuration.reset("languageServer.yaml.fileTypes");
    expect(servers().yaml).toBeUndefined();
    kernel.dispose();
  });
});
