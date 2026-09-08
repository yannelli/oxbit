import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { TaskConfigStore } from "../src/tasks/config.js";
import { TaskRunner } from "../src/tasks/runner.js";
import { detectLinks } from "../src/tasks/environment.js";
import type { TaskDefinition, TaskRun } from "@oxbit/sdk";
const fixtures: { root: string; runner: TaskRunner }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runner.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
async function fixture(
  tasks: Record<string, TaskDefinition>,
  env: Record<string, string> = {},
  forwardPort?: (host: string, port: number) => Promise<number>,
) {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "oxbit-task-runner-"),
  );
  await fs.mkdir(path.join(root, ".oxbit"));
  await fs.writeFile(
    path.join(root, ".oxbit/tasks.json"),
    JSON.stringify({ version: 1, tasks, env }),
  );
  const store = await TaskConfigStore.create(root, { home: root }),
    events: { owner: string; event: string; params: any }[] = [];
  const runner = new TaskRunner(
    store,
    (event, owner) => events.push({ ...event, owner }),
    forwardPort,
  );
  fixtures.push({ root, runner });
  const catalog = await store.catalog();
  return {
    root,
    store,
    runner,
    events,
    id: (name: string) => catalog.tasks.find((t) => t.name === name)!.id,
  };
}
async function until(
  runner: TaskRunner,
  id: string,
  predicate: (task: TaskRun) => boolean,
  timeout = 10000,
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const run = runner.list("owner").find((t) => t.id === id)!;
    if (predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Task state did not converge: ${JSON.stringify(runner.list("owner"))}`,
  );
}
const node = (
  script: string,
  extra: Partial<TaskDefinition> = {},
): TaskDefinition => ({
  command: process.execPath,
  execution: "process",
  args: ["-e", script],
  ...extra,
});
const serviceScript = `const http=require('http');const s=http.createServer((q,r)=>{r.end('hello');});s.listen(Number(process.env.OXBIT_PORT),process.env.OXBIT_HOST,()=>{console.log('ready http://'+process.env.OXBIT_HOST+':'+process.env.OXBIT_PORT+'/hello');});`;
describe("supervised task execution", () => {
  it("keeps SSH link mappings separate for services using the same port on different hosts", async () => {
    const socket = net.createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, "127.0.0.1", resolve),
    );
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const { runner, id } = await fixture(
      {
        api: node(
          serviceScript +
            ";setInterval(()=>console.log('http://127.0.0.1:'+process.env.OXBIT_PORT+'/again'),100);",
          { type: "service", host: "127.0.0.1", port },
        ),
        other: node(serviceScript, { type: "service", host: "::1", port }),
      },
      {},
      async (host) => (host === "127.0.0.1" ? 20001 : 20002),
    );
    const api = await runner.start("owner", id("api"));
    await until(runner, api.id, (run) => run.state === "ready");
    const other = await runner.start("owner", id("other"));
    const ready = await until(runner, other.id, (run) => run.state === "ready");
    expect(ready.links).toContain("http://127.0.0.1:20002/");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const links = runner.list("owner").find((run) => run.id === api.id)!.links;
    expect(links).toContain("http://127.0.0.1:20001/again");
    expect(links.every((link) => !link.includes(":20002"))).toBe(true);
  });
  it("allocates distinct ports, peer variables and an HTTP readiness lifecycle", async () => {
    const { runner, id, root } = await fixture({
      api: node(serviceScript, {
        type: "service",
        ready: { url: "http://$OXBIT_HOST:$OXBIT_PORT/", intervalMs: 100 },
      }),
      worker: node(
        "console.log(JSON.stringify({port:process.env.OXBIT_SERVICE_API_PORT,root:process.env.OXBIT_PROJECT_DIR,custom:process.env.DERIVED}));",
        { dependsOn: ["api"], env: { DERIVED: "${OXBIT_PROJECT_DIR}/cache" } },
      ),
    });
    const worker = await runner.start("owner", id("worker"));
    const done = await until(
      runner,
      worker.id,
      (t) => t.exitCode !== undefined,
    );
    expect(done.state).toBe("completed");
    const api = runner.list("owner").find((t) => t.name === "api")!;
    expect(api.state).toBe("ready");
    expect(api.variables.OXBIT_HOSTNAME).toMatch(
      /^api-[0-9a-f]{8}\.localhost$/,
    );
    expect(
      runner
        .attach(worker.id, "owner")
        .chunks.map((c) => c.data)
        .join(""),
    ).toContain(`${root}/cache`);
    expect(api.links.some((link) => link.endsWith("/hello"))).toBe(true);
    expect(
      await (
        await fetch(`http://127.0.0.1:${api.variables.OXBIT_PORT}`)
      ).text(),
    ).toBe("hello");
    runner.stop(api.id, "owner");
    expect(
      (await until(runner, api.id, (t) => t.exitCode !== undefined)).state,
    ).toBe("stopped");
  });
  it("keeps process arguments literal while expanding variables, and detects environment cycles", async () => {
    const { runner, id } = await fixture({
      literal: node("console.log(process.argv[1])", {
        args: ["-e", "console.log(process.argv[1])", "$DANGEROUS"],
        env: { DANGEROUS: "$(touch SHOULD_NOT_EXIST); quote'" },
      }),
      cycle: node("console.log('no')", { env: { A: "$B", B: "$A" } }),
    });
    const run = await runner.start("owner", id("literal"));
    await until(runner, run.id, (t) => t.exitCode !== undefined);
    expect(
      runner
        .attach(run.id, "owner")
        .chunks.map((c) => c.data)
        .join(""),
    ).toContain("$(touch SHOULD_NOT_EXIST); quote'");
    const cycle = await runner.start("owner", id("cycle"));
    expect(
      (await until(runner, cycle.id, (t) => t.exitCode !== undefined)).message,
    ).toContain("cycle");
  });
  it("checks dependency cycles before starting anything and stops a dependent command after failure", async () => {
    const { runner, id } = await fixture({
      a: { command: "true", dependsOn: ["b"] },
      b: { command: "true", dependsOn: ["a"] },
      fail: node("process.exit(7)"),
      after: node("console.log('must-not-run')", { dependsOn: ["fail"] }),
    });
    await expect(runner.start("owner", id("a"))).rejects.toMatchObject({
      code: "INVALID_TASK_CONFIG",
    });
    expect(runner.list("owner")).toEqual([]);
    const after = await runner.start("owner", id("after"));
    expect(
      (await until(runner, after.id, (t) => t.exitCode !== undefined)).state,
    ).toBe("failed");
    expect(
      runner
        .attach(after.id, "owner")
        .chunks.map((c) => c.data)
        .join(""),
    ).not.toContain("must-not-run");
  });
  it("reports occupied fixed ports without claiming or killing the occupant", async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const port = (occupied.address() as net.AddressInfo).port;
    try {
      const { runner, id } = await fixture({
        web: node(serviceScript, { type: "service", port }),
      });
      const run = await runner.start("owner", id("web"));
      expect(
        (await until(runner, run.id, (t) => t.exitCode !== undefined)).message,
      ).toContain("available port");
      expect(occupied.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
  it("returns one run for concurrent starts and prevents another session from controlling it", async () => {
    const { runner, id } = await fixture({
      wait: node("setInterval(()=>{},1000)"),
    });
    const [a, b] = await Promise.all([
      runner.start("owner", id("wait")),
      runner.start("owner", id("wait")),
    ]);
    expect(a.id).toBe(b.id);
    await expect(runner.start("other", id("wait"))).rejects.toMatchObject({
      code: "TASK_BUSY",
    });
    expect(() => runner.stop(a.id, "other")).toThrow("not found");
    expect(runner.list("other")).toEqual([]);
  });
  it("force stops a process group that ignores TERM and records stop escalation", async () => {
    const script =
      "process.on('SIGTERM',()=>{});console.log('armed');setInterval(()=>{},1000)";
    const { runner, id } = await fixture({
      stubborn: node(script, { stop: { timeoutMs: 120 } }),
    });
    const run = await runner.start("owner", id("stubborn"));
    await until(runner, run.id, (t) => t.seq > 0);
    runner.stop(run.id, "owner");
    const stopped = await until(
      runner,
      run.id,
      (t) => t.exitCode !== undefined,
    );
    expect(stopped.state).toBe("stopped");
    expect(stopped.signal).toBe("SIGKILL");
    const again = await runner.start("owner", id("stubborn"));
    await until(runner, again.id, (t) => t.seq > 0);
    runner.stop(again.id, "owner", true);
    expect(
      (await until(runner, again.id, (t) => t.exitCode !== undefined)).signal,
    ).toBe("SIGKILL");
  });
  it("bounds automatic restarts and fails a service that never becomes ready", async () => {
    const { runner, id } = await fixture({
      crash: node("process.exit(2)", {
        type: "service",
        restart: { policy: "on-failure", maxAttempts: 2, delayMs: 100 },
      }),
      never: node("setInterval(()=>{},1000)", {
        type: "service",
        ready: { pattern: "never", timeoutMs: 150, intervalMs: 100 },
      }),
    });
    const crash = await runner.start("owner", id("crash"));
    const done = await until(runner, crash.id, (t) => t.exitCode !== undefined);
    expect(done.restarts).toBe(2);
    expect(done.state).toBe("failed");
    const never = await runner.start("owner", id("never"));
    expect(
      (await until(runner, never.id, (t) => t.exitCode !== undefined)).message,
    ).toContain("did not become ready");
  });
  it("marks a live service unhealthy and recovers when its HTTP check recovers", async () => {
    const script = `const fs=require('fs');require('http').createServer((q,r)=>{r.statusCode=fs.existsSync('unhealthy')?503:200;r.end();}).listen(+process.env.OXBIT_PORT,process.env.OXBIT_HOST);`;
    const { runner, id, root } = await fixture({
      web: node(script, {
        type: "service",
        ready: {
          url: "http://$OXBIT_HOST:$OXBIT_PORT/health",
          intervalMs: 100,
        },
      }),
    });
    const run = await runner.start("owner", id("web"));
    await until(runner, run.id, (t) => t.state === "ready");
    await fs.writeFile(path.join(root, "unhealthy"), "");
    await until(runner, run.id, (t) => t.state === "unhealthy");
    await fs.unlink(path.join(root, "unhealthy"));
    await until(runner, run.id, (t) => t.state === "ready");
  });
  it("waits for an existing unhealthy service to recover before launching a dependent", async () => {
    const script = `const fs=require('fs');require('http').createServer((q,r)=>{r.statusCode=fs.existsSync('unhealthy')?503:200;r.end();}).listen(+process.env.OXBIT_PORT,process.env.OXBIT_HOST);`;
    const { runner, id, root } = await fixture({
      web: node(script, {
        type: "service",
        ready: {
          url: "http://$OXBIT_HOST:$OXBIT_PORT/health",
          intervalMs: 100,
        },
      }),
      after: node("console.log('after ready')", { dependsOn: ["web"] }),
    });
    const web = await runner.start("owner", id("web"));
    await until(runner, web.id, (t) => t.state === "ready");
    await fs.writeFile(path.join(root, "unhealthy"), "");
    await until(runner, web.id, (t) => t.state === "unhealthy");
    const after = await runner.start("owner", id("after"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runner.list("owner").find((t) => t.id === after.id)?.state).toBe(
      "starting",
    );
    await fs.unlink(path.join(root, "unhealthy"));
    expect(
      (await until(runner, after.id, (t) => t.exitCode !== undefined)).state,
    ).toBe("completed");
  });
  it("does not launch after cancellation during asynchronous discovery", async () => {
    const { runner, id, store } = await fixture({
      one: node("console.log('must not run')"),
    });
    const abort = new AbortController();
    store.branch = async () => {
      abort.abort();
      return "main";
    };
    await expect(
      runner.start("owner", id("one"), abort.signal),
    ).rejects.toThrow();
    expect(runner.list("owner")).toEqual([]);
  });
  it("does not launch a lifecycle hook cancelled during configuration discovery", async () => {
    const { runner, store } = await fixture({});
    const abort = new AbortController(),
      catalog = store.catalog.bind(store);
    store.catalog = async () => {
      const value = await catalog();
      abort.abort();
      return value;
    };
    await expect(
      runner.runHook(
        "owner",
        "echo should-not-start",
        "preinit",
        {},
        {},
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(runner.list("owner")).toEqual([]);
  });
  it("cancels pending dependencies without launching the parent later", async () => {
    const { runner, id } = await fixture({
      wait: node("setTimeout(()=>process.exit(),350)"),
      after: node("console.log('parent ran')", { dependsOn: ["wait"] }),
    });
    const run = await runner.start("owner", id("after"));
    runner.stop(run.id, "owner");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(runner.list("owner").find((t) => t.id === run.id)?.state).toBe(
      "stopped",
    );
    expect(runner.attach(run.id, "owner").chunks).toEqual([]);
  });
  it("rejects cwd traversal and undeclared variables", async () => {
    const { runner, id } = await fixture({
      outside: { command: "echo no", cwd: ".." },
      unknown: node("console.log('no')", { args: ["$OXBIT_MISSING"] }),
    });
    for (const name of ["outside", "unknown"]) {
      const run = await runner.start("owner", id(name));
      expect(
        (await until(runner, run.id, (t) => t.exitCode !== undefined)).state,
      ).toBe("failed");
    }
  });
  it("extracts safe links from ANSI logs and rejects credential-bearing URLs", () => {
    expect(
      detectLinks(
        "\x1b[32mready http://0.0.0.0:3000/path).\x1b[0m https://u:secret@host/path javascript:alert(1)",
      ),
    ).toEqual(["http://localhost:3000/path"]);
  });
});
