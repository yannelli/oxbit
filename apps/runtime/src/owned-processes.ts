import type { ChildProcess } from "node:child_process";

type Observer = (event: { type: "process"; pid: number; running: boolean }) => void;
let observer: Observer | undefined;
const groups = new Set<number>();
export function observeOwnedProcesses(next: Observer) { observer = next; }
export function trackProcess(pid: number | undefined, onExit: (done: () => void) => void) {
  if (!pid) return;
  groups.add(pid);
  observer?.({ type: "process", pid, running: true });
  onExit(() => {
    // Descendants may outlive their leader. Terminate the owned group before forgetting it.
    try { process.kill(-pid, "SIGKILL"); } catch { /* Group already exited. */ }
    groups.delete(pid);
    observer?.({ type: "process", pid, running: false });
  });
}
export function trackChild(child: ChildProcess) {
  trackProcess(child.pid, (done) => child.once("close", done));
}
export function terminateOwnedProcesses() {
  for (const pid of groups) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* Group already exited. */ }
  }
  groups.clear();
}
