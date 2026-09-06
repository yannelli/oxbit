import { translate as tr } from "@zapp/ui";
import React, { useEffect, useState } from "react";
import type { Extension, FeatureOptions } from "@zapp/sdk";
export type Task = {
  id: string;
  command: string;
  state: string;
  output: string;
  seq: number;
  exitCode?: number;
  cancelRequested?: boolean;
  truncated?: boolean;
};
export function appendTaskChunk(
  task: Task,
  chunk: { seq?: number; data: string },
) {
  if (chunk.seq !== undefined && chunk.seq <= task.seq) return false;
  task.seq = chunk.seq ?? task.seq + 1;
  task.output = (task.output + chunk.data).slice(-1048576);
  return true;
}
export function finishTask(task: Task, exitCode: number) {
  task.exitCode = exitCode;
  task.state = task.cancelRequested
    ? "cancelled"
    : exitCode === 0
      ? "completed"
      : "failed";
}
export function createFeature(o: FeatureOptions): Extension {
  const tasks = new Map<string, Task>(),
    listeners = new Set<() => void>(),
    channels = new Map<string, string>([["Tasks", ""]]),
    early = new Map<
      string,
      { data: { seq: number; data: string }[]; exitCode?: number }
    >();
  let disposed = false,
    recovering = false;
  const changed = () => {
    o.kernel.context.set("lastTask", tasks.size > 0);
    o.kernel.context.set(
      "taskRunning",
      [...tasks.values()].some((task) => task.exitCode === undefined),
    );
    for (const listener of listeners) listener();
  };
  const output = {
    append: (channel: string, line: string) => {
      channels.set(
        channel,
        ((channels.get(channel) ?? "") + line).slice(-1048576),
      );
      changed();
    },
    createChannel: (id: string) => {
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
      throw new Error("Connect to a trusted runtime workspace to run tasks");
    return o.runtime.request<T>(method, params);
  };
  const apply = (task: Task, chunk: { seq: number; data: string }) => {
    if (appendTaskChunk(task, chunk)) output.append("Tasks", chunk.data);
  };
  const add = (record: any, drain = true) => {
    for (const [id, item] of tasks) if (tasks.size >= 128 && item.exitCode !== undefined) tasks.delete(id);
    let task = tasks.get(record.id);
    if (!task) {
      task = {
        id: record.id,
        command: record.command ?? "Workspace task",
        state: "running",
        output: "",
        seq: 0,
      };
      tasks.set(task.id, task);
    } else if (record.command) task.command = record.command;
    if (record.exitCode !== undefined) finishTask(task, record.exitCode);
    const pending = early.get(task.id);
    if (pending && drain) {
      for (const chunk of pending.data.sort((a, b) => a.seq - b.seq))
        apply(task, chunk);
      if (pending.exitCode !== undefined) finishTask(task, pending.exitCode);
      early.delete(task.id);
    }
    return task;
  };
  const recover = async () => {
    if (recovering) return;
    recovering = true;
    try {
      const records = await request<any[]>("tasks.list");
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
        const exitCode = pending?.exitCode ?? replay.exitCode;
        if (exitCode !== undefined) finishTask(task, exitCode);
        else task.state = task.cancelRequested ? "cancelling" : "running";
        early.delete(task.id);
      }
      changed();
    } catch (error) {
      if (o.runtime?.connected) o.workbench.notify(String(error), "error");
    } finally {
      recovering = false;
      for (const task of tasks.values()) add(task);
    }
  };
  const run = async (command?: string) => {
    command ??= await o.workbench.prompt(tr("Workspace command"), "pnpm test");
    if (!command?.trim()) return;
    const result = await request<{ id: string }>("tasks.run", { command });
    add({ id: result.id, command });
    changed();
    o.workbench.openPanel("tasks");
    return result.id;
  };
  const cancel = async (id: string) => {
    const task = tasks.get(id);
    if (!task || task.exitCode !== undefined) return;
    task.cancelRequested = true;
    task.state = "cancelling";
    changed();
    try {
      await request("tasks.cancel", { id });
    } catch (error) {
      task.cancelRequested = false;
      task.state = "running";
      changed();
      throw error;
    }
  };
  function Lines({ text }: { text: string }) {
    return React.createElement(
      "pre",
      {
        style: {
          whiteSpace: "pre-wrap",
          margin: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        },
      },
      ...text.split("\n").map((line, index) => {
        const match = line.match(
          /(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.[\w]+):(\d+)(?::(\d+))?/,
        );
        return match
          ? React.createElement(
              "button",
              {
                key: index,
                style: { display: "block", textAlign: "left", font: "inherit" },
                onClick: () =>
                  void o.workbench.openFile(match[1], {
                    line: Number(match[2]),
                    col: Number(match[3] ?? 1),
                  }),
              },
              line + "\n",
            )
          : React.createElement("span", { key: index }, line + "\n");
      }),
    );
  }
  function Panel() {
    const [, render] = useState(0);
    useEffect(() => {
      const listener = () => render((value) => value + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return React.createElement(
      "div",
      {
        className: "tasks-panel",
        style: { padding: 12, height: "100%", overflow: "auto" },
      },
      React.createElement(
        "button",
        {
          onClick: () => {
            void o.kernel.commands
              .execute("tasks.run")
              .catch((error) => o.workbench.notify(String(error), "error"));
          },
        },
        tr("Run task"),
      ),
      ...[...tasks.values()].map((task) =>
        React.createElement(
          "section",
          {
            key: task.id,
            style: {
              padding: "8px 0",
              borderBottom: "1px solid var(--border)",
            },
          },
          React.createElement(
            "strong",
            null,
            task.command +
              " · " +
              task.state +
              (task.exitCode === undefined ? "" : " · exit " + task.exitCode),
          ),
          React.createElement(
            "button",
            {
              disabled: task.state === "cancelling",
              onClick: () => {
                void (
                  task.exitCode === undefined
                    ? cancel(task.id)
                    : run(task.command)
                ).catch((error) => o.workbench.notify(String(error), "error"));
              },
            },
            task.exitCode === undefined ? tr("Cancel") : tr("Rerun"),
          ),
          task.truncated &&
            React.createElement(
              "p",
              { role: "status" },
              tr("Earlier task output is no longer available"),
            ),
          React.createElement(Lines, { text: task.output }),
        ),
      ),
    );
  }
  function Output() {
    const [, render] = useState(0);
    const [channel, setChannel] = useState("Tasks");
    useEffect(() => {
      const listener = () => render((value) => value + 1);
      listeners.add(listener);
      const off = o.kernel.contributions.subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    }, []);
    const contributed = o.kernel.contributions.list("outputChannel"),
      names = [
        ...new Set([...channels.keys(), ...contributed.map((c) => c.id)]),
      ],
      selected = names.includes(channel) ? channel : "Tasks",
      data = contributed.find((item) => item.id === selected)?.data as
        { lines?: string[] } | undefined;
    return React.createElement(
      "div",
      {
        className: "output-panel",
        style: { padding: 12, height: "100%", overflow: "auto" },
      },
      React.createElement(
        "select",
        {
          "aria-label": tr("Output channel"),
          value: selected,
          onChange: (event: any) => setChannel(event.target.value),
        },
        ...names.map((name) =>
          React.createElement("option", { key: name }, name),
        ),
      ),
      React.createElement(Lines, {
        text: channels.get(selected) ?? data?.lines?.join("\n") ?? "",
      }),
    );
  }
  return {
    manifest: {
      manifestVersion: 1,
      id: "zapp.tasks",
      name: "Tasks and Output",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: ["tasks"],
    },
    activate(ctx) {
      disposed = false;
      ctx.own(ctx.services.register("tasks", { run, cancel, tasks }));
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
        ["tasks.runBuild", "Run Build Task", () => run("pnpm build")],
        [
          "tasks.cancel",
          "Cancel Running Task",
          async () => {
            for (const task of tasks.values())
              if (task.exitCode === undefined) await cancel(task.id);
          },
        ],
        [
          "tasks.rerun",
          "Rerun Last Task",
          () => run([...tasks.values()].at(-1)?.command),
        ],
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
            }
            changed();
          }),
        );
        ctx.subscribe(
          o.runtime.subscribe("tasks.exit", (params) => {
            const task = tasks.get(params.id);
            if (task && !recovering) finishTask(task, params.exitCode);
            else {
              const pending = early.get(params.id) ?? { data: [] };
              pending.exitCode = params.exitCode;
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
