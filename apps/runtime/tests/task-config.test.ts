import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TaskConfigStore } from "../src/tasks/config.js";
import { readSource, writeTask, writeSettings } from "../src/tasks/adapters.js";
import { definition } from "../src/tasks/validation.js";
import { runCommand } from "../src/processes.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function workspace() {
  const dir = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "oxbit-task-config-"),
  );
  roots.push(dir);
  const root = path.join(dir, "project");
  await fs.mkdir(root);
  return {
    root,
    dir,
    store: await TaskConfigStore.create(root, { home: dir }),
  };
}
async function put(root: string, name: string, text: string) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), text);
}
describe("task configuration discovery and round trips", () => {
  it("uses a stable project UUID and private default without creating project files", async () => {
    const { root, dir, store } = await workspace(),
      catalog = await store.catalog(),
      source = catalog.sources[0];
    expect(catalog.projectId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(catalog.privatePath).toBe(
      path.join(dir, ".oxbit/projects", catalog.projectId, "tasks.json"),
    );
    const updated = await store.save({
      sourceId: source.id,
      name: "hello",
      task: { command: "echo hello" },
      expectedRevision: null,
    });
    expect(updated.tasks[0].command).toBe("echo hello");
    expect(await fs.readdir(root)).toEqual([]);
    expect((await TaskConfigStore.create(root, { home: dir })).projectId).toBe(
      catalog.projectId,
    );
    expect((await fs.stat(catalog.privatePath)).mode & 0o777).toBe(0o600);
  });
  it("keeps private tasks when an existing project initializes Git", async () => {
    const { root, dir, store } = await workspace();
    const catalog = await store.catalog();
    await store.save({
      sourceId: catalog.defaultSourceId,
      name: "hello",
      task: { command: "echo hello" },
      expectedRevision: null,
    });
    expect((await runCommand("git", ["init"], { cwd: root })).exitCode).toBe(0);
    const reopened = await TaskConfigStore.create(root, { home: dir });
    expect(reopened.projectId).toBe(store.projectId);
    expect((await reopened.catalog()).tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "hello", command: "echo hello" }),
      ]),
    );
  });
  it("edits detected npm script bodies while preserving package fields and lifecycle semantics", async () => {
    const { root, store } = await workspace();
    await put(
      root,
      "package.json",
      '{\n  "name": "demo",\n  "scripts": {"prebuild":"echo before", "build":"tsc"},\n  "custom": {"keep": true}\n}\n',
    );
    const catalog = await store.catalog(),
      source = catalog.sources.find((s) => s.kind === "npm")!,
      task = catalog.tasks.find((t) => t.name === "build")!;
    expect(catalog.defaultSourceId).toBe(source.id);
    expect(task).toMatchObject({
      command: "npm",
      execution: "process",
      args: ["run", "build"],
      sourceCommand: "tsc",
    });
    await store.save({
      sourceId: source.id,
      name: "build",
      task: {
        command: "npm",
        execution: "process",
        args: ["run", "build"],
        group: "build",
      },
      sourceCommand: "tsc -b",
      expectedRevision: source.revision,
    });
    const saved = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    );
    expect(saved.scripts).toEqual({ prebuild: "echo before", build: "tsc -b" });
    expect(saved.custom.keep).toBe(true);
    expect(saved.oxbit.tasks.build.group).toBe("build");
  });
  it("preserves VS Code JSONC comments, unknown fields, and task platform options", () => {
    const text =
      '{\n// keep me\n"version":"2.0.0", "inputs":[{"id":"keep"}], "tasks":[{"label":"web","type":"shell","command":"node server.js","detail":"keep detail","linux":{"command":"node linux.js"},"options":{"cwd":"${workspaceFolder}"},"isBackground":true,}],\n}';
    const imported = readSource("vscode", text);
    expect(imported.tasks[0].definition.cwd).toBe("${OXBIT_PROJECT_DIR}");
    const changed = writeTask("vscode", text, "web", {
      ...imported.tasks[0].definition,
      command: "node new.js",
      type: "service",
      port: "auto",
      env: { MODE: "dev", CACHE: "${OXBIT_PROJECT_DIR}/${USER}" },
      ready: { pattern: "listening" },
    });
    expect(changed).toContain("// keep me");
    expect(changed).toContain('"keep detail"');
    expect(changed).toContain('"keep"');
    expect(changed).toContain('"cwd": "${workspaceFolder}"');
    expect(changed).toContain('"CACHE": "${workspaceFolder}/${env:USER}"');
    expect(readSource("vscode", changed).tasks[0].definition).toMatchObject({
      command: "node new.js",
      port: "auto",
      ready: { pattern: "listening" },
    });
  });
  it("does not execute unresolved IDE inputs or provider-specific tasks", () => {
    const imported = readSource(
      "vscode",
      JSON.stringify({
        version: "2.0.0",
        tasks: [
          { label: "input", type: "shell", command: "echo ${input:secret}" },
          { label: "provider", type: "docker-build", command: "docker" },
        ],
      }),
    );
    expect(imported.tasks.every((task) => !!task.disabledReason)).toBe(true);
  });
  it("maps Paseo setup/teardown and preserves unrelated project settings", () => {
    const text = JSON.stringify({
      worktree: {
        setup: ["npm ci"],
        teardown: "echo bye",
        terminals: [{ name: "shell" }],
      },
      scripts: { api: { command: "node api", type: "service", port: 3021 } },
      metadataGeneration: { keep: true },
    });
    expect(readSource("paseo", text).worktree).toEqual({
      init: ["npm ci"],
      preteardown: "echo bye",
    });
    const next = writeSettings(
      "paseo",
      writeTask("paseo", text, "api", {
        command: "node api2",
        type: "service",
        port: { min: 4000, max: 4010 },
        stop: { timeoutMs: 1000 },
      }),
      {
        preinit: "echo prepare",
        init: "npm install",
        preteardown: "echo before",
        teardown: "echo after",
      },
      { A: "value" },
    );
    expect(JSON.parse(next).metadataGeneration.keep).toBe(true);
    expect(JSON.parse(next).worktree.terminals).toHaveLength(1);
    expect(readSource("paseo", next).tasks[0].definition.port).toEqual({
      min: 4000,
      max: 4010,
    });
    expect(readSource("paseo", next).worktree.teardown).toBe("echo after");
  });
  it("imports JetBrains run configurations and edits their XML without dropping unrelated settings", () => {
    const text =
      '<component name="ProjectRunConfigurationManager"><!-- keep --><configuration name="Web" type="ShConfigurationType"><option name="SCRIPT_TEXT" value="echo &quot;ready&quot;"/><option name="EXECUTE_SCRIPT_FILE" value="false"/><option name="UNRELATED" value="keep"/><envs><env name="MODE" value="dev"/></envs></configuration><configuration name="Java" type="Application"><option name="MAIN_CLASS_NAME" value="Main"/></configuration></component>';
    const imported = readSource("jetbrains", text);
    expect(imported.tasks[0].definition).toMatchObject({
      command: 'echo "ready"',
      env: { MODE: "dev" },
    });
    expect(imported.tasks[1].disabledReason).toContain("IDE");
    const changed = writeTask("jetbrains", text, "Web", {
      command: "echo updated",
      cwd: "${OXBIT_PROJECT_DIR}/src",
      type: "service",
      ready: { pattern: "ready" },
    });
    expect(changed).toContain("<!-- keep -->");
    expect(changed).toContain(
      'name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$/src"',
    );
    expect(changed).toContain('name="UNRELATED"');
    expect(changed).toContain('name="MAIN_CLASS_NAME"');
    expect(readSource("jetbrains", changed).tasks[0].definition.command).toBe(
      "echo updated",
    );
    expect(() =>
      readSource(
        "jetbrains",
        '<!DOCTYPE a [<!ENTITY b SYSTEM "file:///etc/passwd">]><a/>',
      ),
    ).toThrow("entities");
  });
  it("detects Composer, Procfile, Make and Just entries without evaluating configuration", () => {
    expect(
      readSource(
        "composer",
        '{"scripts":{"test":["@php test.php","echo done"]}}',
      ).tasks[0],
    ).toMatchObject({
      name: "test",
      definition: {
        command: "composer",
        execution: "process",
        args: ["run-script", "test"],
      },
    });
    expect(
      readSource("procfile", "# keep\nweb: npm start\nworker: jobs\n").tasks,
    ).toHaveLength(2);
    expect(
      readSource(
        "make",
        ".PHONY: test\ntest: deps\n\t@echo hi\nVAR := x\n",
      ).tasks.map((t) => t.name),
    ).toEqual(["test"]);
    expect(
      readSource(
        "just",
        "test:\n  echo hi\nparam target:\n  echo param\n",
      ).tasks.map((t) => t.name),
    ).toEqual(["test"]);
  });
  it("rejects stale edits and never overwrites malformed files", async () => {
    const { root, store } = await workspace();
    await put(
      root,
      "paseo.json",
      '{"scripts":{"test":{"command":"echo old"}}}',
    );
    const source = (await store.catalog()).sources.find(
      (s) => s.kind === "paseo",
    )!;
    await put(
      root,
      "paseo.json",
      '{"scripts":{"test":{"command":"echo new"}}}',
    );
    await expect(
      store.save({
        sourceId: source.id,
        name: "test",
        task: { command: "echo overwritten" },
        expectedRevision: source.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await put(root, "paseo.json", "{invalid");
    expect(
      (await store.catalog()).sources
        .find((s) => s.id === source.id)
        ?.diagnostics.join(),
    ).toContain("Invalid JSON");
    await expect(
      store.save({
        sourceId: source.id,
        name: "test",
        task: { command: "x" },
        expectedRevision: source.revision,
      }),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(await fs.readFile(path.join(root, "paseo.json"), "utf8")).toBe(
      "{invalid",
    );
  });
  it("rejects symlinked config destinations and duplicate task creation", async () => {
    const { root, dir, store } = await workspace();
    await fs.writeFile(
      path.join(dir, "outside.json"),
      '{"version":1,"tasks":{}}',
    );
    await fs.mkdir(path.join(root, ".oxbit"));
    await fs.symlink(
      path.join(dir, "outside.json"),
      path.join(root, ".oxbit/tasks.json"),
    );
    expect(
      (await store.catalog()).sources
        .find((s) => !s.private)
        ?.diagnostics.join(),
    ).toContain("symlinks");
    const source = (await store.catalog()).sources.find((s) => s.private)!;
    const next = await store.save({
      sourceId: source.id,
      name: "one",
      task: { command: "true" },
      expectedRevision: null,
      create: true,
    });
    await expect(
      store.save({
        sourceId: source.id,
        name: "one",
        task: { command: "false" },
        expectedRevision: next.sources.find((s) => s.private)!.revision,
        create: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("exports a shareable config with dependency mapping and reports unsupported imports", async () => {
    const { root, store } = await workspace();
    await put(
      root,
      ".vscode/tasks.json",
      JSON.stringify({
        version: "2.0.0",
        tasks: [
          { label: "build", command: "echo build" },
          { label: "test", command: "echo test", dependsOn: "build" },
          { label: "debug", type: "custom" },
        ],
      }),
    );
    const catalog = await store.catalog();
    const result = await store.share(
      Object.fromEntries(catalog.sources.map((s) => [s.id, s.revision])),
    );
    expect(result.skipped).toEqual(["debug"]);
    expect(result.catalog.tasks.map((t) => t.name)).toEqual(["build", "test"]);
    const saved = JSON.parse(
      await fs.readFile(path.join(root, ".oxbit/tasks.json"), "utf8"),
    );
    expect(saved.tasks.test.dependsOn).toEqual(["build"]);
    expect(saved.autoDetect).toBe(false);
    expect(
      await fs.readFile(path.join(root, ".vscode/tasks.json"), "utf8"),
    ).toContain('"debug"');
  });
  it("exports private tasks without duplicate imports", async () => {
    const { store } = await workspace();
    const source = (await store.catalog()).sources.find((s) => s.private)!;
    const catalog = await store.save({
      sourceId: source.id,
      name: "one",
      task: { command: "true" },
      expectedRevision: null,
    });
    const result = await store.share(
      Object.fromEntries(catalog.sources.map((s) => [s.id, s.revision])),
    );
    expect(result.catalog.tasks.map((t) => t.name)).toEqual(["one"]);
  });
  it("edits a VS Code task with absent optional options and imports launch commands", () => {
    const text = JSON.stringify({
      version: "2.0.0",
      tasks: [{ label: "one", command: "true" }],
    });
    expect(
      readSource(
        "vscode",
        writeTask("vscode", text, "one", { command: "echo changed" }),
      ).tasks[0].definition.command,
    ).toBe("echo changed");
    const launch = readSource(
      "vscode-launch",
      JSON.stringify({
        version: "0.2.0",
        configurations: [
          {
            name: "Node",
            type: "node",
            request: "launch",
            program: "${workspaceFolder}/server.js",
            args: ["hello world"],
            preLaunchTask: "build",
          },
          {
            name: "Python",
            type: "debugpy",
            request: "launch",
            module: "http.server",
          },
          { name: "Attach", type: "node", request: "attach", processId: "1" },
        ],
      }),
    );
    expect(launch.tasks[0].definition).toMatchObject({
      command: "node",
      execution: "process",
      args: ["${OXBIT_PROJECT_DIR}/server.js", "hello world"],
      dependsOn: ["build"],
    });
    expect(launch.tasks[1].definition.args).toEqual(["-m", "http.server"]);
    expect(launch.tasks[2].disabledReason).toContain("attach");
  });
  it("validates ports, environment entries and process policy limits", () => {
    for (const task of [
      { command: "true", port: 0 },
      { command: "true", ports: { a: 1, A: 2 } },
      { command: "true", restart: { policy: "on-failure", maxAttempts: 11 } },
      { command: "true", env: { "BAD-NAME": "x" } },
      { command: "true", mystery: true },
    ])
      expect(() => definition(task)).toThrow();
  });
});
