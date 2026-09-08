import type {
  Extension,
  FeatureOptions,
  TaskCatalog,
  TaskRun,
  TaskWorktree,
} from "@oxbit/sdk";
import { createTaskViews, type TaskModel } from "./views.js";
export type Task = {
  id: string;
  command: string;
  state: string;
  output: string;
  seq: number;
  exitCode?: number;
  cancelRequested?: boolean;
  truncated?: boolean;
} & Partial<Omit<TaskRun, "id" | "command" | "state" | "seq" | "exitCode">>;
export function appendTaskChunk(
  task: Task,
  chunk: { seq?: number; data: string },
) {
  if (chunk.seq !== undefined && chunk.seq <= task.seq) return false;
  task.seq = chunk.seq ?? task.seq + 1;
  task.output = (task.output + chunk.data).slice(-1048576);
  return true;
}
export function finishTask(task: Task, exitCode: number, state?: string) {
  task.exitCode = exitCode;
  task.state =
    state === "stopped" && task.cancelRequested
      ? "cancelled"
      : (state ??
        (task.cancelRequested
          ? "cancelled"
          : exitCode === 0
            ? "completed"
            : "failed"));
}
export function applyTaskSnapshot(task: Task, record: Partial<TaskRun>) {
  // Status events can arrive before their initiating RPC response or replay.
  // Output acknowledgement has a separate sequence and must never jump ahead.
  if (
    record.statusVersion !== undefined &&
    task.statusVersion !== undefined &&
    record.statusVersion < task.statusVersion
  )
    return;
  const { seq: _seq, ...metadata } = record;
  Object.assign(task, metadata);
  if (record.exitCode !== undefined)
    finishTask(task, record.exitCode, record.state);
}
export function createFeature(o: FeatureOptions): Extension {
  const tasks = new Map<string, Task>(),
    listeners = new Set<() => void>(),
    channels = new Map<string, string>([["Tasks", ""]]);
  const early = new Map<
    string,
    { data: { seq: number; data: string }[]; exitCode?: number; state?: string }
  >();
  let disposed = false,
    recovering = false,
    catalog: TaskCatalog | undefined,
    worktrees: TaskWorktree[] = [],
    error = "",
    selected: string | undefined,
    loading = false;
  const changed = () => {
    o.kernel.context.set("lastTask", tasks.size > 0);
    o.kernel.context.set(
      "taskRunning",
      [...tasks.values()].some((task) => task.exitCode === undefined),
    );
    for (const listener of listeners) listener();
  };
  const output = {
    append(channel: string, text: string) {
      channels.set(
        channel,
        ((channels.get(channel) ?? "") + text).slice(-1048576),
      );
      changed();
    },
    createChannel(id: string) {
      if (channels.has(id))
        throw new Error(`Output channel ${id} already exists`);
      channels.set(id, "");
      changed();
      return {
        append: (text: string) => output.append(id, text),
        appendLine: (text: string) => output.append(id, text + "\n"),
        dispose: () => {
          channels.delete(id);
          changed();
        },
      };
    },
  };
  const request = <T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (!o.runtime?.connected)
      throw new Error("Connect to a runtime workspace to use tasks");
    return o.runtime.request<T>(method, params);
  };
  const apply = (task: Task, chunk: { seq: number; data: string }) => {
    if (appendTaskChunk(task, chunk)) output.append("Tasks", chunk.data);
  };
  const add = (record: Partial<TaskRun> & { id: string }, drain = true) => {
    for (const [id, task] of tasks)
      if (tasks.size >= 128 && task.exitCode !== undefined) tasks.delete(id);
    let task = tasks.get(record.id);
    if (!task) {
      task = {
        id: record.id,
        command: record.command ?? "Workspace task",
        state: record.state ?? "running",
        output: "",
        seq: 0,
      };
      tasks.set(record.id, task);
    }
    applyTaskSnapshot(task, record);
    const pending = early.get(task.id);
    if (pending && drain) {
      for (const chunk of pending.data.sort((a, b) => a.seq - b.seq))
        apply(task, chunk);
      if (pending.exitCode !== undefined)
        finishTask(task, pending.exitCode, pending.state);
      early.delete(task.id);
    }
    return task;
  };
  const refresh = async () => {
    if (!o.runtime?.connected) {
      catalog = undefined;
      changed();
      return;
    }
    loading = true;
    changed();
    try {
      const next = await request<TaskCatalog>("tasks.catalog");
      if (disposed) return;
      catalog = next;
      error = "";
      try {
        worktrees = await request<TaskWorktree[]>("tasks.worktrees");
      } catch {
        worktrees = [];
      }
    } catch (failure) {
      error = (failure as Error).message;
    } finally {
      loading = false;
      changed();
    }
  };
  const recover = async () => {
    if (recovering || !o.runtime?.connected) return;
    recovering = true;
    try {
      const records = await request<TaskRun[]>("tasks.list");
      if (disposed) return;
      const ids = new Set(records.map((record) => record.id));
      for (const task of tasks.values())
        if (!ids.has(task.id) && task.exitCode === undefined) {
          task.state = "terminated (runtime restarted)";
          task.exitCode = -1;
        }
      for (const record of records) {
        const task = add(record, false),
          replay = await request("tasks.attach", {
            id: task.id,
            afterSeq: task.seq,
          }),
          pending = early.get(task.id);
        task.truncated ||= replay.truncated === true;
        for (const chunk of [...replay.chunks, ...(pending?.data ?? [])].sort(
          (a, b) => a.seq - b.seq,
        ))
          apply(task, chunk);
        add(replay, false);
        if (pending?.exitCode !== undefined)
          finishTask(task, pending.exitCode, pending.state);
        early.delete(task.id);
      }
    } catch (failure) {
      if (o.runtime?.connected) error = (failure as Error).message;
    } finally {
      recovering = false;
      for (const task of tasks.values()) add({ id: task.id });
      changed();
    }
    await refresh();
  };
  const run = async (command?: string) => {
    command ??= await o.workbench.prompt("Workspace command", "npm test");
    if (!command?.trim()) return;
    const record = await request<TaskRun>("tasks.run", { command });
    add(record);
    selected = record.id;
    changed();
    o.workbench.openPanel("tasks");
    return record.id;
  };
  const start = async (taskId: string) => {
    const record = await request<TaskRun>("tasks.start", { taskId });
    add(record);
    selected = record.id;
    changed();
    o.workbench.openPanel("tasks");
    return record.id;
  };
  const stop = async (id: string, force = false) => {
    const record = await request<TaskRun>("tasks.stop", { id, force });
    add(record);
    changed();
  };
  const cancel = async (id: string) => {
    const task = tasks.get(id);
    if (task) task.cancelRequested = true;
    try {
      await stop(id);
    } catch (error) {
      if (task) task.cancelRequested = false;
      throw error;
    }
  };
  const restart = async (id: string) => {
    const record = await request<TaskRun>("tasks.restart", { id });
    add(record);
    selected = record.id;
    changed();
  };
  const model: TaskModel = {
    options: o,
    tasks,
    channels,
    get catalog() {
      return catalog;
    },
    get worktrees() {
      return worktrees;
    },
    get selected() {
      return selected;
    },
    get error() {
      return error;
    },
    get loading() {
      return loading;
    },
    select: (id) => {
      selected = id;
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request,
    refresh,
    run,
    start,
    stop,
    restart,
    report: async (action) => {
      try {
        error = "";
        await action();
      } catch (failure) {
        error = (failure as Error).message;
      } finally {
        changed();
      }
    },
  };
  const { Panel, Output } = createTaskViews(model);
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.tasks",
      name: "Tasks and Services",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["tasks"],
    },
    activate(ctx) {
      disposed = false;
      ctx.own(
        ctx.services.register("tasks", {
          run,
          start,
          cancel,
          stop,
          restart,
          tasks,
          refresh,
          catalog: () => catalog,
        }),
      );
      ctx.own(ctx.services.register("output", output));
      ctx.own(
        ctx.contributions.register({
          id: "tasks",
          kind: "panel",
          title: "Tasks",
          component: Panel,
          order: 40,
        }),
      );
      ctx.own(
        ctx.contributions.register({
          id: "output",
          kind: "panel",
          title: "Output",
          component: Output,
          order: 30,
        }),
      );
      for (const [id, title, action] of [
        ["tasks.run", "Run Task", () => run()],
        [
          "tasks.open",
          "Manage Tasks and Services",
          () => o.workbench.openPanel("tasks"),
        ],
        [
          "tasks.runBuild",
          "Run Build Task",
          async () => {
            await refresh();
            const build =
              catalog?.tasks.find((task) => task.group === "build") ??
              catalog?.tasks.find((task) => task.name === "build");
            if (build) await start(build.id);
            else {
              o.workbench.openPanel("tasks");
              o.workbench.notify(
                "No build task detected. Add a task with the build group.",
              );
            }
          },
        ],
        [
          "tasks.cancel",
          "Stop Running Tasks",
          async () => {
            for (const task of tasks.values())
              if (task.exitCode === undefined) await stop(task.id);
          },
        ],
        [
          "tasks.forceStop",
          "Force Stop Running Tasks",
          async () => {
            for (const task of tasks.values())
              if (task.exitCode === undefined) await stop(task.id, true);
          },
        ],
        [
          "tasks.rerun",
          "Rerun Last Task",
          () => {
            const last = [...tasks.values()].at(-1);
            return last ? restart(last.id) : run();
          },
        ],
        ["tasks.refresh", "Refresh Detected Tasks", refresh],
      ] as const)
        ctx.own(
          ctx.commands.register({
            id,
            title,
            run: action,
            ...(id === "tasks.runBuild" ? { shortcut: "Mod+Shift+B" } : {}),
          }),
        );
      if (o.runtime) {
        ctx.subscribe(
          o.runtime.subscribe("tasks.status", (record) => {
            add(record);
            changed();
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("tasks.data", (params) => {
            const task = tasks.get(params.id);
            if (task && !recovering) apply(task, params);
            else {
              const pending = early.get(params.id) ?? { data: [] };
              pending.data.push({ seq: params.seq, data: params.data });
              while (
                pending.data.reduce(
                  (size, chunk) => size + chunk.data.length,
                  0,
                ) > 1048576
              )
                pending.data.shift();
              early.set(params.id, pending);
              while (early.size > 128) early.delete(early.keys().next().value!);
            }
            changed();
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("tasks.exit", (params) => {
            const task = tasks.get(params.id);
            if (task && !recovering)
              finishTask(task, params.exitCode, params.state);
            else {
              const pending = early.get(params.id) ?? { data: [] };
              pending.exitCode = params.exitCode;
              pending.state = params.state;
              early.set(params.id, pending);
            }
            changed();
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("connection.change", (params) => {
            if (params.state === "connected") void recover();
            else {
              for (const task of tasks.values())
                if (task.exitCode === undefined) task.state = "disconnected";
              changed();
            }
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("workspace.trust", () => {
            void recover();
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("operation.recovered", (operation) => {
            if (!operation.method?.startsWith("tasks.")) return;
            if (operation.status === "completed") {
              void recover();
              o.workbench.notify("Task operation completed after reconnect");
            } else if (
              ["failed", "interrupted", "unknown"].includes(operation.status)
            ) {
              void refresh();
              o.workbench.notify(
                operation.error?.message ??
                  "Task operation was interrupted; inspect its state before retrying",
                "warning",
              );
            }
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("runtime.terminated", () => {
            for (const task of tasks.values())
              if (task.exitCode === undefined) {
                task.exitCode = -1;
                task.state = "terminated (runtime stopped)";
              }
            changed();
          }),
        );
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;
        ctx.subscribe(
          o.runtime.subscribe("fs.change", () => {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => void refresh(), 500);
          }),
        );
        ctx.subscribe(() => clearTimeout(refreshTimer));
        void recover();
      }
      ctx.subscribe(() => {
        disposed = true;
        listeners.clear();
        early.clear();
      });
    },
  };
}
