import type { Params } from "@oxbit/agent-core";
import type { Command } from "./complete.js";
import type { ConfigOption, SessionState, SessionUpdate } from "./connection.js";

/** `_meta.oxbit.goal` on a session/update; null clears it. */
export interface GoalStatus { objective?: string; status: string; turns?: number; tokens?: number }
/** `_meta.oxbit.loop` on a session/update; null clears it. */
export interface LoopStatus { status?: string; iteration?: number; max?: number; interval?: string; next?: string }
export interface Choice { value: string; name: string }
export interface Status {
  sessionId?: string;
  title?: string;
  mode: string;
  model?: string;
  models: Choice[];
  reasoning?: ConfigOption;
  usage?: { used: number; size: number };
  goal?: GoalStatus;
  loop?: LoopStatus;
  commands: Command[];
}

export const emptyStatus = (): Status => ({ mode: "ask", models: [], commands: [] });

/** Model, reasoning and mode from ACP config options; absent options leave fields unchanged. */
export function fromConfig(options: unknown): Partial<Status> {
  if (!Array.isArray(options)) return {};
  const list = options as ConfigOption[];
  const model = list.find((option) => option.id === "model" || option.category === "model");
  const reasoning = list.find((option) => option.id === "reasoning" || option.category === "thought_level");
  const mode = list.find((option) => option.id === "mode" || option.category === "mode");
  return {
    ...model ? { model: model.currentValue, models: model.options.map(({ value, name }) => ({ value, name })) } : {},
    ...reasoning ? { reasoning } : {},
    ...mode ? { mode: mode.currentValue } : {},
  };
}

export function fromSession(session: SessionState): Status {
  const models = session.models?.availableModels.map((model) => ({ value: model.modelId, name: model.name })) ?? [];
  return {
    ...emptyStatus(),
    sessionId: session.sessionId,
    mode: session.modes?.currentModeId ?? "ask",
    model: session.models?.currentModelId,
    models,
    ...fromConfig(session.configOptions),
  };
}

const commandsOf = (value: unknown): Command[] => Array.isArray(value)
  ? value.filter((item: Params) => typeof item?.name === "string").map((item: Params) => ({
    name: item.name.replace(/^\//, ""), description: typeof item.description === "string" ? item.description : "",
    ...typeof item.input?.hint === "string" ? { hint: item.input.hint } : {} }))
  : [];

/** The status after one session/update, or the same object when the update does not touch it. */
export function applyStatus(status: Status, update: SessionUpdate): Status {
  let next = status;
  switch (update.sessionUpdate) {
    case "available_commands_update": next = { ...status, commands: commandsOf(update.availableCommands) }; break;
    case "current_mode_update": if (typeof update.currentModeId === "string") next = { ...status, mode: update.currentModeId }; break;
    case "session_info_update": if (typeof update.title === "string") next = { ...status, title: update.title }; break;
    case "config_option_update": next = { ...status, ...fromConfig(update.configOptions) }; break;
    case "usage_update":
      if (typeof update.used === "number" && typeof update.size === "number" && update.size > 0) next = { ...status, usage: { used: update.used, size: update.size } };
      break;
  }
  const meta = update._meta?.oxbit as Params | undefined;
  if (meta && "goal" in meta) next = { ...next, goal: meta.goal && typeof meta.goal.status === "string" ? meta.goal : undefined };
  if (meta && "loop" in meta) next = { ...next, loop: meta.loop ?? undefined };
  return next;
}

export const modelName = (status: Status) => status.models.find((model) => model.value === status.model)?.name ?? status.model;
