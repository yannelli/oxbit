import { useRef } from "react";
import { Dialog, Icon, translate as tr } from "@oxbit/ui";
import type { Session } from "@oxbit/app-workbench";

export function WorkspaceDialog({
  session,
  close,
  useBrowserWorkspace,
  openDirectory,
  onConnect,
  openProvider,
  importWorkspace,
}: {
  session: Session;
  close(): void;
  useBrowserWorkspace(): Promise<void>;
  openDirectory(): Promise<void>;
  onConnect(): void;
  openProvider(id: string): Promise<void>;
  importWorkspace(file: File): Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const run = (command: string) => {
    close();
    void session.workbench.run(command);
  };
  const choices = [
    {
      icon: "folderOpen",
      title: "Open directory",
      description: "Work with files on this computer.",
      run: openDirectory,
    },
    {
      icon: "cloud",
      title: "Connect to a runtime",
      description: "Open a local or remote project with development tools.",
      run: onConnect,
    },
    {
      icon: "folder",
      title: "Browser workspace",
      description: "Continue with files saved in this browser.",
      run: useBrowserWorkspace,
    },
    ...session.kernel.contributions.list("filesystem").map((provider) => ({
      icon: "folderOpen",
      title: provider.title,
      description: "Open a workspace from this provider.",
      run: () => openProvider(provider.id),
    })),
  ];
  return (
    <Dialog
      title={tr("Open Workspace")}
      className="workspace-dialog"
      onClose={close}
    >
      <p className="dialog-intro">{tr("Choose where you want to work.")}</p>
      <div className="workspace-choices">
        {choices.map((choice) => (
          <button
            type="button"
            className="workspace-choice"
            key={choice.title}
            onClick={() => void choice.run()}
          >
            <span className="workspace-choice-icon">
              <Icon name={choice.icon} size={20} />
            </span>
            <span className="workspace-choice-copy">
              <strong>{tr(choice.title)}</strong>
              <small>{tr(choice.description)}</small>
            </span>
            <Icon name="chevR" size={14} />
          </button>
        ))}
      </div>
      <div className="workspace-tools" aria-label={tr("Workspace actions")}>
        <button type="button" onClick={() => input.current?.click()}>
          <Icon name="plus" />
          {tr("Import workspace…")}
        </button>
        <button type="button" onClick={() => run("workspace.export")}>
          <Icon name="save" />
          {tr("Export workspace")}
        </button>
        <button type="button" onClick={() => run("git.clone")}>
          <Icon name="git" />
          {tr("Clone repository…")}
        </button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importWorkspace(file);
            event.target.value = "";
          }}
        />
      </div>
      {session.workbench.state.workspaceOpen && (
        <footer className="workspace-dialog-footer">
          <span>
            <small>{tr("Current workspace")}</small>
            <strong>{session.workbench.state.projectName}</strong>
          </span>
          <button
            type="button"
            className="button quiet"
            onClick={() => run("workspace.close")}
          >
            {tr("Close Workspace")}
          </button>
        </footer>
      )}
    </Dialog>
  );
}
