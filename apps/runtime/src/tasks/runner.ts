import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { RpcError, MAX_BUFFER_BYTES } from "@oxbit/protocol";
import type {
  ConfiguredTask,
  TaskCatalog,
  TaskDefinition,
  TaskRun,
} from "@oxbit/sdk";
import type { ProcessEvent, Chunk } from "../processes.js";
import { trackChild } from "../owned-processes.js";
import { TaskConfigStore } from "./config.js";
import { definition, shellQuote } from "./validation.js";
import { TaskPorts, tcpReady } from "./ports.js";
import { detectLinks, expand, taskEnvironment } from "./environment.js";
type Emit = (event: ProcessEvent, owner: string) => void;
type Context = {
  root?: string;
  projectDir?: string;
  sourceDir?: string;
  preinitDir?: string;
  branch?: string;
};
interface InternalRun {
  value: TaskRun;
  owner: string;
  task: ConfiguredTask;
  catalog: TaskCatalog;
  context: Context;
  child?: ChildProcess;
  chunks: Chunk[];
  bytes: number;
  tail: string;
  readySeen: boolean;
  stopRequested: boolean;
  updates: Set<() => void>;
  done: Promise<void>;
  doneResolve: () => void;
  monitor?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  ended: boolean;
  generation: number;
  timedOut: boolean;
}
export class TaskRunner {
  private runs = new Map<string, InternalRun>();
  private ports: TaskPorts;
  private publicPorts = new Map<string, Map<number, number>>();
  private closed = false;
  constructor(
    readonly store: TaskConfigStore,
    private emit: Emit,
    private forwardPort?: (host: string, port: number) => Promise<number>,
  ) {
    this.ports = new TaskPorts(store.root);
  }
  private publicLinks(run: InternalRun, links: string[]) {
    if (!this.forwardPort) return links;
    const plan = this.ports.get(run.task.id);
    return links.map((link) => {
      try {
        const url = new URL(link),
          port = this.publicPorts
            .get(run.task.id)
            ?.get(Number(url.port || (url.protocol === "https:" ? 443 : 80)));
        if (
          port &&
          [
            "localhost",
            "127.0.0.1",
            "[::1]",
            plan?.hostname,
            plan?.host,
          ].includes(url.hostname)
        ) {
          url.hostname = "127.0.0.1";
          url.port = String(port);
          return url.href;
        }
      } catch {
        /* Ignore incomplete URLs. */
      }
      return link;
    });
  }
  private live(task: InternalRun) {
    return !task.ended;
  }
  private snapshot(run: InternalRun): TaskRun {
    return structuredClone(run.value);
  }
  private publish(run: InternalRun) {
    run.value.statusVersion++;
    this.emit(
      {
        event: "tasks.status",
        params: this.snapshot(run) as unknown as Record<string, unknown>,
      },
      run.owner,
    );
    for (const update of run.updates) update();
    run.updates.clear();
  }
  private state(run: InternalRun, state: TaskRun["state"], message?: string) {
    if (run.value.state === state && run.value.message === message) return;
    run.value.state = state;
    run.value.message = message;
    this.publish(run);
  }
  private owned(id: string, owner: string) {
    const task = this.runs.get(id);
    if (!task || task.owner !== owner)
      throw new RpcError("NOT_FOUND", "Task run was not found");
    return task;
  }
  list(owner: string) {
    return [...this.runs.values()]
      .filter((task) => task.owner === owner)
      .map((task) => this.snapshot(task));
  }
  attach(id: string, owner: string, afterSeq = 0) {
    const task = this.owned(id, owner);
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      afterSeq > task.value.seq
    )
      throw new RpcError("INVALID_PARAMS", "Invalid task sequence");
    return {
      ...this.snapshot(task),
      chunks: task.chunks.filter((chunk) => chunk.seq > afterSeq),
      truncated: afterSeq < (task.chunks[0]?.seq ?? 1) - 1,
    };
  }
  private resolveDependency(
    task: ConfiguredTask,
    name: string,
    catalog: TaskCatalog,
  ) {
    const exact = catalog.tasks.find((candidate) => candidate.id === name);
    if (exact) return exact;
    const same = catalog.tasks.find(
      (candidate) =>
        candidate.name === name && candidate.sourceId === task.sourceId,
    );
    if (same) return same;
    const matches = catalog.tasks.filter(
      (candidate) => candidate.name === name,
    );
    if (matches.length !== 1)
      throw new RpcError(
        "INVALID_TASK_CONFIG",
        `Dependency ${name} of ${task.name} is ${matches.length ? "ambiguous; use its task ID" : "missing"}`,
      );
    return matches[0];
  }
  private validateGraph(
    task: ConfiguredTask,
    catalog: TaskCatalog,
    stack = new Set<string>(),
    visited = new Set<string>(),
  ) {
    if (task.disabledReason)
      throw new RpcError("UNSUPPORTED_TASK", task.disabledReason);
    if (stack.has(task.id))
      throw new RpcError(
        "INVALID_TASK_CONFIG",
        `Task dependency cycle at ${task.name}`,
      );
    if (visited.has(task.id)) return;
    definition(this.definitionOf(task));
    stack.add(task.id);
    for (const name of task.dependsOn ?? [])
      this.validateGraph(
        this.resolveDependency(task, name, catalog),
        catalog,
        stack,
        visited,
      );
    stack.delete(task.id);
    visited.add(task.id);
  }
  private definitionOf(task: ConfiguredTask): TaskDefinition {
    const {
      id: _id,
      name: _name,
      sourceId: _source,
      sourceCommand: _command,
      disabledReason: _reason,
      ...value
    } = task;
    return value;
  }
  async start(owner: string, taskId: string, signal?: AbortSignal) {
    if (this.closed) throw new RpcError("CANCELLED", "Task runner is closing");
    const catalog = await this.store.catalog(),
      task = catalog.tasks.find((task) => task.id === taskId);
    if (!task) throw new RpcError("NOT_FOUND", "Configured task was not found");
    this.validateGraph(task, catalog);
    const branch = await this.store.branch();
    signal?.throwIfAborted();
    return this.snapshot(this.begin(owner, task, catalog, { branch }));
  }
  async run(owner: string, command: string, signal?: AbortSignal) {
    const catalog = await this.store.catalog();
    const branch = await this.store.branch();
    signal?.throwIfAborted();
    return this.snapshot(
      this.begin(
        owner,
        {
          ...definition({ command }),
          id: "adhoc/" + randomUUID(),
          name: command.slice(0, 120),
          sourceId: "adhoc",
        },
        catalog,
        { branch },
      ),
    );
  }
  async runHook(
    owner: string,
    command: string,
    name: string,
    context: Context,
    env: Record<string, string>,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted)
      throw new RpcError("CANCELLED", "Worktree operation was cancelled");
    const catalog = { ...(await this.store.catalog()), tasks: [], env };
    signal?.throwIfAborted();
    const run = this.begin(
      owner,
      { command, id: "hook/" + randomUUID(), name, sourceId: "hook" },
      catalog,
      context,
    );
    const cancel = () => this.stop(run.value.id, owner);
    signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 600000);
    timeout.unref();
    try {
      await run.done;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
    if (run.value.state !== "completed")
      throw new RpcError(
        "HOOK_FAILED",
        `${name} failed (exit ${run.value.exitCode ?? -1}). Inspect its task output before retrying.`,
        { runId: run.value.id },
      );
    return this.snapshot(run);
  }
  private begin(
    owner: string,
    task: ConfiguredTask,
    catalog: TaskCatalog,
    context: Context,
  ): InternalRun {
    if (this.closed) throw new RpcError("CANCELLED", "Task runner is closing");
    const previous = [...this.runs.values()].find(
      (run) => run.value.taskId === task.id && this.live(run),
    );
    if (previous) {
      if (previous.owner !== owner)
        throw new RpcError("TASK_BUSY", "Another session is running this task");
      return previous;
    }
    if ([...this.runs.values()].filter((run) => this.live(run)).length >= 16)
      throw new RpcError("LIMIT", "Maximum 16 running tasks");
    for (const [id, run] of this.runs)
      if (this.runs.size >= 128 && run.ended) this.runs.delete(id);
    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });
    const run: InternalRun = {
      owner,
      task: structuredClone(task),
      catalog,
      context,
      chunks: [],
      bytes: 0,
      tail: "",
      readySeen: false,
      stopRequested: false,
      updates: new Set(),
      done,
      doneResolve,
      ended: false,
      generation: 0,
      timedOut: false,
      value: {
        statusVersion: 0,
        id: randomUUID(),
        ...(!["adhoc", "hook"].includes(task.sourceId)
          ? { taskId: task.id }
          : {}),
        name: task.name,
        command: task.command,
        type: task.type ?? "command",
        state: "starting",
        cwd: context.root ?? this.store.root,
        startedAt: Date.now(),
        restarts: 0,
        seq: 0,
        links: [],
        variables: {},
      },
    };
    this.runs.set(run.value.id, run);
    this.publish(run);
    void this.launch(run).catch((error) => {
      if (!run.ended) {
        this.output(run, String((error as Error).message) + "\n");
        this.finish(run, -1, undefined, String((error as Error).message));
      }
    });
    return run;
  }
  private async launch(run: InternalRun) {
    const dependency = async (name: string) => {
      if (run.stopRequested) return;
      const task = this.resolveDependency(run.task, name, run.catalog),
        other = this.begin(run.owner, task, run.catalog, run.context);
      this.state(run, "starting", `Waiting for ${task.name}`);
      while (!run.ended && !run.stopRequested) {
        if (
          task.type === "service"
            ? other.value.state === "ready"
            : other.value.state === "completed"
        )
          return;
        if (other.ended)
          throw new RpcError(
            "DEPENDENCY_FAILED",
            `Dependency ${task.name} did not complete/become ready`,
          );
        let update!: () => void;
        const changed = new Promise<void>((resolve) => {
          update = resolve;
          other.updates.add(update);
        });
        try {
          await Promise.race([changed, run.done]);
        } finally {
          other.updates.delete(update);
        }
      }
    };
    if (run.task.dependencyOrder === "parallel")
      await Promise.all((run.task.dependsOn ?? []).map(dependency));
    else for (const name of run.task.dependsOn ?? []) await dependency(name);
    if (run.stopRequested || run.ended) return;
    if (!run.task.command.trim()) {
      this.finish(run, 0);
      return;
    }
    const services = [
      run.task,
      ...run.catalog.tasks.filter((task) => task.id !== run.task.id),
    ];
    await this.ports.ensure(
      services,
      new Set(
        [...this.runs.values()]
          .filter((run) => run.child && !run.ended)
          .map((run) => run.task.id),
      ),
    );
    if (run.stopRequested || run.ended) return;
    await this.spawnAttempt(run);
  }
  private async spawnAttempt(run: InternalRun) {
    const generation = ++run.generation;
    const { env, variables } = taskEnvironment(
      this.store,
      run.task,
      this.ports,
      run.catalog,
      run.context,
    );
    await fs.mkdir(variables.OXBIT_PREINIT_DIR, {
      recursive: true,
      mode: 0o700,
    });
    const cwd = path.resolve(
      run.context.root ?? this.store.root,
      expand(run.task.cwd ?? ".", env),
    );
    const real = await fs.realpath(cwd);
    // Lifecycle cwd may be its private staging directory; arbitrary task cwd stays in the workspace.
    const bound = await fs.realpath(run.context.root ?? this.store.root),
      relative = path.relative(bound, real);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      throw new RpcError(
        "INVALID_PATH",
        "Task working directory must be within this workspace",
      );
    const args = (run.task.args ?? []).map((arg) => expand(arg, env));
    const plan = this.ports.get(run.task.id);
    if (plan && this.forwardPort) {
      const forwarded = new Map<number, number>();
      for (const port of [plan.port, ...Object.values(plan.ports)])
        forwarded.set(
          port,
          await this.forwardPort(
            plan.host === "0.0.0.0"
              ? "127.0.0.1"
              : plan.host === "::"
                ? "::1"
                : plan.host,
            port,
          ),
        );
      this.publicPorts.set(run.task.id, forwarded);
    }
    await this.ports.release(run.task.id);
    if (run.ended || run.stopRequested || this.closed) return;
    run.value.variables = variables;
    run.value.cwd = real;
    run.value.links = [];
    run.readySeen = false;
    run.timedOut = false;
    run.tail = "";
    const command =
      run.task.execution === "process"
        ? expand(run.task.command, env)
        : run.task.command +
          (args.length ? " " + args.map(shellQuote).join(" ") : "");
    const child =
      run.task.execution === "process"
        ? spawn(command, args, {
            cwd: real,
            env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(command, {
            cwd: real,
            env,
            shell: true,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
    run.child = child;
    run.value.pid = child.pid;
    trackChild(child);
    const stdout = new StringDecoder("utf8"),
      stderr = new StringDecoder("utf8");
    child.stdout!.on("data", (data: Buffer) =>
      this.output(run, stdout.write(data)),
    );
    child.stderr!.on("data", (data: Buffer) =>
      this.output(run, stderr.write(data)),
    );
    child.on("error", (error) => {
      run.value.message = error.message;
      this.output(run, error.message + "\n");
    });
    child.on("exit", () => {
      // A shell can exit while children still hold its pipes. Reap that owned group as well.
      this.signal(run, "SIGTERM");
      clearTimeout(run.killTimer);
      run.killTimer = setTimeout(() => this.signal(run, "SIGKILL"), 1500);
      run.killTimer.unref();
    });
    child.on("close", (code, signal) => {
      this.output(run, stdout.end());
      this.output(run, stderr.end());
      void this.exited(run, code ?? -1, signal ?? undefined, generation).catch(
        (error) => this.finish(run, -1, undefined, String(error)),
      );
    });
    if (run.task.type === "service") {
      this.state(run, "starting");
      this.monitor(run, generation, Date.now());
    } else this.state(run, "running");
  }
  private output(run: InternalRun, data: string) {
    if (!data) return;
    run.tail = (run.tail + data).slice(-16384);
    if (run.task.ready?.pattern && run.tail.includes(run.task.ready.pattern))
      run.readySeen = true;
    const links = [
      ...new Set([
        ...run.value.links,
        ...this.publicLinks(run, detectLinks(run.tail)),
      ]),
    ].slice(0, 32);
    if (links.join("\n") !== run.value.links.join("\n")) {
      run.value.links = links;
      this.publish(run);
    }
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 16384, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const chunk = { seq: ++run.value.seq, data: data.slice(offset, end) };
      offset = end;
      run.chunks.push(chunk);
      run.bytes += Buffer.byteLength(chunk.data);
      while (run.bytes > MAX_BUFFER_BYTES && run.chunks.length > 1)
        run.bytes -= Buffer.byteLength(run.chunks.shift()!.data);
      this.emit(
        {
          event: "tasks.data",
          params: { id: run.value.id, ...chunk },
          stream: `task:${run.value.id}`,
          seq: chunk.seq,
        },
        run.owner,
      );
    }
  }
  private monitor(run: InternalRun, generation: number, started: number) {
    const interval = run.task.ready?.intervalMs ?? 500,
      timeout = run.task.ready?.timeoutMs ?? 30000;
    let everReady = false;
    const check = async () => {
      if (
        run.ended ||
        run.stopRequested ||
        run.generation !== generation ||
        !run.child
      )
        return;
      const plan = this.ports.get(run.task.id);
      let healthy = !run.task.ready?.pattern || run.readySeen;
      try {
        if (run.task.ready?.url) {
          const url = new URL(
            expand(run.task.ready.url, {
              ...process.env,
              ...run.value.variables,
            }),
          );
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new Error(
              "Readiness URL must use HTTP(S) without credentials",
            );
          // Probes use the process host; dynamic .localhost names need no OS DNS entry.
          if (plan && url.hostname === plan.hostname)
            url.hostname = plan.host === "0.0.0.0" ? "127.0.0.1" : plan.host;
          const response = await fetch(url, {
            signal: AbortSignal.timeout(1500),
            redirect: "manual",
          });
          healthy &&= response.status >= 200 && response.status < 400;
          await response.body?.cancel();
        } else if (
          plan &&
          (!run.task.ready?.pattern || run.task.port !== undefined)
        )
          healthy &&= await tcpReady(plan.host, plan.port);
      } catch {
        healthy = false;
      }
      if (
        run.ended ||
        run.stopRequested ||
        run.generation !== generation ||
        !run.child
      )
        return;
      if (healthy) {
        everReady = true;
        if (plan)
          run.value.links = [
            ...new Set([
              ...this.publicLinks(run, [
                `http://${plan.hostname}:${plan.port}`,
              ]),
              ...run.value.links,
            ]),
          ].slice(0, 32);
        this.state(run, "ready");
      } else if (everReady)
        this.state(
          run,
          "unhealthy",
          "Service process is running but its readiness check is failing",
        );
      else if (Date.now() - started >= timeout) {
        run.timedOut = true;
        run.value.message = `Service did not become ready within ${timeout} ms`;
        this.output(run, run.value.message + "\n");
        this.signal(run, "SIGKILL");
        return;
      }
      run.monitor = setTimeout(() => void check(), interval);
      run.monitor.unref();
    };
    run.monitor = setTimeout(() => void check(), 50);
    run.monitor.unref();
  }
  private signal(run: InternalRun, signal: NodeJS.Signals) {
    const child = run.child;
    if (!child?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* The owned process group has already exited. */
    }
  }
  private async exited(
    run: InternalRun,
    code: number,
    signal: string | undefined,
    generation: number,
  ) {
    if (run.ended || run.generation !== generation) return;
    clearTimeout(run.monitor);
    clearTimeout(run.killTimer);
    run.child = undefined;
    run.value.pid = undefined;
    const failed = code !== 0 || run.timedOut || run.task.type === "service";
    if (
      !run.stopRequested &&
      !this.closed &&
      failed &&
      run.task.restart?.policy === "on-failure" &&
      run.value.restarts < (run.task.restart.maxAttempts ?? 3)
    ) {
      run.value.restarts++;
      this.state(
        run,
        "restarting",
        `Restart ${run.value.restarts} after exit ${code}`,
      );
      await this.ports.reserveAgain(run.task.id);
      if (run.stopRequested || run.ended) return;
      run.restartTimer = setTimeout(
        () => {
          void this.spawnAttempt(run).catch((error) =>
            this.finish(run, -1, undefined, String(error)),
          );
        },
        (run.task.restart.delayMs ?? 1000) *
          Math.min(2 ** (run.value.restarts - 1), 8),
      );
      run.restartTimer.unref();
      return;
    }
    this.finish(run, run.timedOut ? -1 : code, signal, run.value.message);
    if (!this.closed)
      await this.ports.reserveAgain(run.task.id).catch(() => {});
  }
  private finish(
    run: InternalRun,
    code: number,
    signal?: string,
    message?: string,
  ) {
    if (run.ended) return;
    run.ended = true;
    clearTimeout(run.monitor);
    clearTimeout(run.killTimer);
    clearTimeout(run.restartTimer);
    run.value.exitCode = code;
    run.value.signal = signal;
    run.value.endedAt = Date.now();
    run.value.pid = undefined;
    this.state(
      run,
      run.stopRequested
        ? "stopped"
        : code === 0 && run.task.type !== "service"
          ? "completed"
          : "failed",
      message,
    );
    run.doneResolve();
    this.emit(
      {
        event: "tasks.exit",
        params: {
          id: run.value.id,
          exitCode: code,
          state: run.value.state,
          signal,
        },
      },
      run.owner,
    );
  }
  stop(id: string, owner: string, force = false) {
    const run = this.owned(id, owner);
    if (run.ended) return this.snapshot(run);
    run.stopRequested = true;
    clearTimeout(run.monitor);
    clearTimeout(run.restartTimer);
    this.state(
      run,
      "stopping",
      force
        ? "Force stopping process group"
        : "Waiting for process group to stop",
    );
    if (!run.child) this.finish(run, -1);
    else {
      this.signal(
        run,
        force ? "SIGKILL" : (run.task.stop?.signal ?? "SIGTERM"),
      );
      clearTimeout(run.killTimer);
      if (!force) {
        run.killTimer = setTimeout(() => {
          this.state(
            run,
            "stopping",
            "Stop timeout reached; force stopping process group",
          );
          this.signal(run, "SIGKILL");
        }, run.task.stop?.timeoutMs ?? 5000);
        run.killTimer.unref();
      }
    }
    return this.snapshot(run);
  }
  async restart(id: string, owner: string, signal?: AbortSignal) {
    const run = this.owned(id, owner);
    this.stop(id, owner);
    await run.done;
    signal?.throwIfAborted();
    return run.value.taskId
      ? this.start(owner, run.value.taskId, signal)
      : this.run(owner, run.task.command, signal);
  }
  async stopInDirectory(directory: string) {
    const runs = [...this.runs.values()].filter(
      (run) =>
        run.value.cwd === directory ||
        run.value.cwd.startsWith(directory + path.sep),
    );
    for (const run of runs) if (!run.ended) this.stop(run.value.id, run.owner);
    await Promise.all(runs.map((run) => run.done));
  }
  revoke(owner: string) {
    for (const run of this.runs.values())
      if (run.owner === owner && !run.ended)
        this.stop(run.value.id, owner, true);
  }
  async close() {
    this.closed = true;
    for (const run of this.runs.values())
      if (!run.ended) this.stop(run.value.id, run.owner, true);
    await Promise.all([...this.runs.values()].map((run) => run.done));
    await this.ports.close();
  }
}
