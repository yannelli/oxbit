import { useState } from "react";
import { Dialog, translate as tr } from "@oxbit/ui";
import type { PlannedCommit, PlannedFile } from "./ai.js";

const REMOVE = "remove";

export function CommitPlanDialog({
  plan: initial,
  run,
  partial,
  onClose,
}: {
  plan: PlannedCommit[];
  run(plan: PlannedCommit[], step: (index: number) => void): Promise<void>;
  /** Partially staged paths on a host that cannot restore exact index entries. */
  partial: string[];
  onClose(): void;
}) {
  const [plan, setPlan] = useState(initial);
  const [step, setStep] = useState<number>();
  const [error, setError] = useState("");
  const busy = step !== undefined;
  const commits = plan.filter((entry) => entry.files.length);
  const ready = commits.length > 0 && commits.every((entry) => entry.message.trim());
  const planned = new Set(commits.flatMap((entry) => entry.files.map((file) => file.path)));
  const restaged = partial.filter((path) => !planned.has(path));
  const update = (index: number, change: Partial<PlannedCommit>) =>
    setPlan((current) => current.map((entry, i) => (i === index ? { ...entry, ...change } : entry)));
  const move = (from: number, file: PlannedFile, target: string) =>
    setPlan((current) =>
      current.map((entry, i) => ({
        ...entry,
        files:
          i === from
            ? entry.files.filter((other) => other.path !== file.path)
            : target !== REMOVE && i === Number(target)
              ? [...entry.files, file]
              : entry.files,
      })),
    );
  const commitAll = () => {
    let current = 0;
    setError("");
    setStep(0);
    const advance = (index: number) => {
      current = index;
      setStep(index);
    };
    void run(commits, advance).then(onClose, (failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPlan(commits.slice(current));
      setStep(undefined);
    });
  };
  return (
    <Dialog title={tr("Review AI commits")} className="scm-plan-dialog" onClose={busy ? () => {} : onClose}>
      <p className="dialog-intro">
        {tr("Oxbit will make these commits in order. Edit messages or move files before you commit.")}
      </p>
      <ol className="scm-plan">
        {plan.map((entry, index) => (
          <li key={index} className="scm-plan-commit" aria-current={step === index ? "step" : undefined}>
            <textarea
              aria-label={tr("Message for commit {0}", { "0": index + 1 })}
              rows={2}
              value={entry.message}
              disabled={busy}
              onChange={(event) => update(index, { message: event.target.value })}
            />
            {!entry.files.length && <p className="scm-hint">{tr("No files. This commit is skipped.")}</p>}
            <ul>
              {entry.files.map((file) => (
                <li key={file.path}>
                  <span title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}>
                    {file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
                  </span>
                  <select
                    aria-label={tr("Move {0}", { "0": file.path })}
                    value={String(index)}
                    disabled={busy}
                    onChange={(event) => move(index, file, event.target.value)}
                  >
                    {plan.map((_, target) => (
                      <option key={target} value={String(target)}>
                        {tr("Commit {0}", { "0": target + 1 })}
                      </option>
                    ))}
                    <option value={REMOVE}>{tr("Leave uncommitted")}</option>
                  </select>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {restaged.length > 0 && (
        <p className="scm-hint" role="note">
          {tr("{0} partially staged files stay out of these commits. They will be fully staged afterward.", {
            "0": restaged.length,
          })}
        </p>
      )}
      {busy && (
        <p role="status">
          {tr("Committing {0} of {1}…", { "0": step + 1, "1": commits.length })}
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          {tr("Cancel")}
        </button>
        <button className="button primary" disabled={busy || !ready} onClick={commitAll}>
          {tr("Commit All")}
        </button>
      </div>
    </Dialog>
  );
}
