import { useSyncExternalStore } from "react";
import { Icon, translate as tr } from "@oxbit/ui";
import type { Extension, Kernel } from "@oxbit/sdk";
import { RUNTIME_CONNECTOR_SERVICE, type RuntimeConnector, type RuntimeStatus, type WorkbenchController } from "@oxbit/workbench";
import { runtimeConfiguration } from "./configuration.js";
import { RuntimePage } from "./page.js";
import type { RuntimeSettingsAccess } from "./sections.js";
import { oneTap } from "./store.js";
import "./runtime.css";

export { RuntimePage } from "./page.js";
export type { RuntimeSettingsAccess } from "./sections.js";
export { RuntimeStatusStore, clientStatus, oneTap, formatUptime, type RuntimeClientLike } from "./store.js";
export { runtimeConfiguration, keepAliveMs, keepAliveOptions, KEEP_ALIVE_SETTING, AUTO_RECONNECT_SETTING, type KeepAlive } from "./configuration.js";

const connectorOf = (kernel: Kernel) => kernel.services.optional<RuntimeConnector>(RUNTIME_CONNECTOR_SERVICE);
const idle: RuntimeStatus = { state: "disconnected" };
const noSubscription = () => () => {};

export function kernelSettings(kernel: Kernel): RuntimeSettingsAccess {
  return {
    get: id => kernel.configuration.get(id),
    set: (id, value) => kernel.configuration.set(id, value as never),
  };
}

function RuntimeTab({ kernel }: { kernel: Kernel; workbench: WorkbenchController }) {
  const connector = connectorOf(kernel);
  if (!connector)
    return <div className="runtime-page"><p className="runtime-hint">{tr("This window has no runtime connection.")}</p></div>;
  return <RuntimePage connector={connector} settings={kernelSettings(kernel)} />;
}

function RuntimeStatusItem({ kernel, workbench }: { kernel: Kernel; workbench: WorkbenchController }) {
  const connector = connectorOf(kernel);
  const status = useSyncExternalStore(connector?.subscribe ?? noSubscription, connector?.status ?? (() => idle));
  const busy = status.state === "connecting" || status.state === "reconnecting";
  const label = status.state === "connected" ? status.name ?? tr("Connected")
    : busy ? tr("Connecting…") : status.state === "failed" ? tr("Connection failed") : tr("Local");
  return (
    <button className="runtime-status-item" data-state={status.state} aria-busy={busy}
      title={tr("Runtime connection")} onClick={() => void workbench.run("runtime.cloud")}>
      <Icon name={status.state === "connected" ? "cloudCheck" : busy ? "sync" : "cloudOff"} size={13} />
      <span>{label}</span>
    </button>
  );
}

export function createFeature({ kernel, workbench }: { kernel: Kernel; workbench: WorkbenchController }): Extension {
  const open = () => void workbench.openView("runtime", "Runtime", RuntimeTab, {}, { contributionId: "runtime" });
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.runtime",
      name: "Runtime",
      version: "1.0.0",
      sdk: "^1.0.0",
      description: "Connect, pair, and keep runtimes alive from one page.",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      configuration: runtimeConfiguration.map(setting => ({ ...setting, enum: setting.enum?.slice() })),
    },
    activate(ctx) {
      ctx.own(ctx.contributions.register({ id: "runtime", kind: "tab", title: "Runtime", component: RuntimeTab }));
      ctx.own(ctx.contributions.register({
        id: "runtime.status", kind: "statusItem", title: "Runtime connection",
        component: () => <RuntimeStatusItem kernel={kernel} workbench={workbench} />,
      }));
      ctx.own(ctx.commands.register({ id: "runtime.open", title: "Open Runtime", category: "Runtime", run: open }));
      ctx.own(ctx.commands.register({
        id: "runtime.cloud", title: "Connect Runtime", category: "Runtime",
        run: () => oneTap(connectorOf(kernel), open),
      }));
    },
  };
}
