import type { ACPConnection } from "@oxbit/sdk";

export interface SessionControl {
  id: string;
  name: string;
  description?: string;
  value: string;
  options: { value: string; label: string }[];
  method:
    "session/set_config_option" | "session/set_mode" | "session/set_model";
}

/** Config options supersede legacy selectors, even without category metadata. */
export function sessionControls(connection?: ACPConnection): SessionControl[] {
  if (!connection?.sessionId) return [];
  if (connection.configOptions != null)
    return connection.configOptions
      .filter((config) => config.type === "select")
      .map((config) => ({
        id: config.id,
        name: config.name,
        description: config.description,
        value: config.currentValue,
        options: config.options
          .flatMap((item) => ("group" in item ? item.options : [item]))
          .map((item) => ({ value: item.value, label: item.name })),
        method: "session/set_config_option",
      }));
  const controls: SessionControl[] = [];
  if (connection.modes)
    controls.push({
      id: "mode",
      name: "Agent mode",
      value: connection.modes.currentModeId,
      options: connection.modes.availableModes.map((mode) => ({
        value: mode.id,
        label: mode.name,
      })),
      method: "session/set_mode",
    });
  if (connection.models)
    controls.push({
      id: "model",
      name: "Agent model",
      value: connection.models.currentModelId,
      options: connection.models.availableModels.map((model) => ({
        value: model.modelId,
        label: model.name,
      })),
      method: "session/set_model",
    });
  return controls;
}
