import { AGENT_ACTIVITY_SERVICE, type AgentActivityService, type AgentActivityUpdate, type FeatureOptions } from "@oxbit/sdk";
import { translate as tr } from "@oxbit/ui";

export const AGENT_VIEW = "agent-acp";
type Badge = { count: number; label: string; tone?: "attention" | "info" };
type Outcome = "finished" | "failed";
export interface ThreadState {
  agent: string;
  title: string;
  connected: boolean;
  busy: boolean;
  startedAt?: number;
  pending: number;
  /** Title of the latest tool call. */
  tool?: string;
}

export function activityUpdate(thread: ThreadState, outcome?: Outcome): AgentActivityUpdate | null {
  if (!thread.connected) return null;
  const base = { agent: thread.agent, title: thread.title, pending: thread.pending };
  if (thread.pending)
    return { ...base, status: "waiting", detail: thread.pending === 1
      ? tr("1 request needs an answer") : tr("{0} requests need an answer", { 0: thread.pending }) };
  if (thread.busy)
    return { ...base, status: "working", detail: thread.tool || tr("Working"), startedAt: thread.startedAt };
  if (outcome)
    return { ...base, status: outcome, detail: tr(outcome === "failed" ? "Agent turn failed" : "Agent finished") };
  return null;
}

/** Badge, toast, and system notification state for the agent panel. */
export class Attention {
  private unseen = false;
  private badge = "null";
  private outcome?: Outcome;
  private activity = "null";
  constructor(private options: FeatureOptions) {}
  private panelHidden() {
    return this.options.workbench.panelVisible?.(AGENT_VIEW) === false;
  }
  /** True while Oxbit's window is hidden or another app has focus. */
  private appHidden() {
    return typeof document !== "undefined" && (document.hidden || !document.hasFocus());
  }
  sync(pending: number, thread?: () => ThreadState) {
    if (thread) this.mirror(thread);
    if (this.unseen && this.options.workbench.panelVisible?.(AGENT_VIEW))
      this.unseen = false;
    const badge: Badge | undefined = pending
      ? { count: pending, label: tr("Agent needs input"), tone: "attention" }
      : this.unseen
        ? { count: 0, label: tr("Agent finished"), tone: "info" }
        : undefined;
    const key = JSON.stringify(badge ?? null);
    if (key === this.badge) return;
    this.badge = key;
    this.options.workbench.setViewBadge?.(AGENT_VIEW, badge);
  }
  seen() {
    this.unseen = false;
  }
  requestArrived(title: string) {
    this.alert(tr("Agent needs your input"), title);
  }
  turnEnded(title: string, failed: boolean) {
    this.outcome = failed ? "failed" : "finished";
    if (this.panelHidden()) this.unseen = true;
    this.alert(tr(failed ? "Agent turn failed" : "Agent finished"), title);
  }
  dispose() {
    if (this.activity !== "null") this.send(null);
  }
  /** Mirrors the active thread to the host's agent activity service, such as an iOS Live Activity. */
  private mirror(thread: () => ThreadState) {
    if (!this.options.kernel.services.optional(AGENT_ACTIVITY_SERVICE)) return;
    const state = thread();
    if (state.busy) this.outcome = undefined;
    const update = activityUpdate(state, this.outcome);
    const key = JSON.stringify(update);
    if (key === this.activity) return;
    this.activity = key;
    this.send(update);
  }
  private send(update: AgentActivityUpdate | null) {
    const service = this.options.kernel.services.optional<AgentActivityService>(AGENT_ACTIVITY_SERVICE);
    service?.update(update).catch((error: unknown) => console.warn("Agent activity update failed", error));
  }
  private alert(message: string, body: string) {
    const appHidden = this.appHidden();
    if (!appHidden && !this.panelHidden()) return;
    this.options.workbench.notify(message, "info", {
      actions: [{ title: tr("Open Agent"), command: "agentACP.open" }],
      source: "Agent ACP",
    });
    if (
      !appHidden ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted" ||
      this.options.kernel.configuration?.get<string>("agentACP.notifications") === "never"
    )
      return;
    const notification = new Notification(message, { body, tag: "oxbit-agent-acp" });
    notification.onclick = () => {
      window.focus();
      this.options.workbench.openPanel(AGENT_VIEW);
      notification.close();
    };
  }
}
