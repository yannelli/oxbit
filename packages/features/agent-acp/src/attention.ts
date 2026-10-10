import type { FeatureOptions } from "@oxbit/sdk";
import { translate as tr } from "@oxbit/ui";

export const AGENT_VIEW = "agent-acp";
type Badge = { count: number; label: string; tone?: "attention" | "info" };

/** Badge, toast, and system notification state for the agent panel. */
export class Attention {
  private unseen = false;
  private badge = "null";
  constructor(private options: FeatureOptions) {}
  private panelHidden() {
    return this.options.workbench.panelVisible?.(AGENT_VIEW) === false;
  }
  private appHidden() {
    return typeof document !== "undefined" && document.hidden;
  }
  sync(pending: number) {
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
    if (this.panelHidden()) this.unseen = true;
    this.alert(tr(failed ? "Agent turn failed" : "Agent finished"), title);
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
