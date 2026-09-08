import { useEffect, useState, useSyncExternalStore } from "react";
import type { DocumentSymbol, DocumentSymbolProvider } from "@oxbit/sdk";
import type { WorkbenchController } from "./controller.js";

type Language = DocumentSymbolProvider & {
  subscribe?(listener: () => void): () => void;
  servers?: { id: string; state: string; error: string }[];
};
export function symbolKind(kind: number) {
  return (
    [
      "Symbol",
      "File",
      "Module",
      "Namespace",
      "Package",
      "Class",
      "Method",
      "Property",
      "Field",
      "Constructor",
      "Enum",
      "Interface",
      "Function",
      "Variable",
      "Constant",
      "String",
      "Number",
      "Boolean",
      "Array",
      "Object",
      "Key",
      "Null",
      "Enum member",
      "Struct",
      "Event",
      "Operator",
      "Type parameter",
    ][kind] ?? "Symbol"
  );
}

export function useDocumentSymbols(
  workbench: WorkbenchController,
  enabled = true,
) {
  useSyncExternalStore(workbench.subscribe, workbench.snapshot);
  const path = workbench.activePath();
  const language = workbench.kernel.services.optional<Language>("language");
  const [revision, setRevision] = useState(0);
  const [serverState, setServerState] = useState("");
  const [result, setResult] = useState<{
    path?: string;
    revision: number;
    loading: boolean;
    items: DocumentSymbol[];
    error?: string;
  }>({ revision: -1, loading: false, items: [] });
  useEffect(() => {
    if (!enabled) return;
    const changed = workbench.kernel.events.on("document.change", ({ id }) => {
      if (workbench.documents.get(path ?? "")?.id === id)
        setRevision((value) => value + 1);
    });
    // Retry when availability changes, not on starting/failed notifications:
    // a failed initialization must remain an error instead of a retry loop.
    const update = () =>
      setServerState(
        JSON.stringify(
          language?.servers?.map(({ id, state }) => [
            id,
            state === "ready",
            state === "unavailable",
          ]),
        ) ?? "",
      );
    update();
    const stop = language?.subscribe?.(update);
    return () => {
      changed.dispose();
      stop?.();
    };
  }, [enabled, path, language, workbench]);
  useEffect(() => {
    if (!enabled || !path) return;
    const controller = new AbortController();
    setResult({ path, revision, loading: true, items: [] });
    const timer = setTimeout(() => {
      const request = language?.symbols
        ? language.symbols(path, controller.signal)
        : Promise.reject(new Error("Language intelligence is unavailable."));
      void request
        .then((items) => {
          if (!controller.signal.aborted)
            setResult({ path, revision, items, loading: false });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setResult({
              path,
              revision,
              items: [],
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, path, revision, serverState, language, workbench]);
  const current = result.path === path && result.revision === revision;
  return {
    path,
    items: enabled && current ? result.items : [],
    loading: enabled && !!path && (!current || result.loading),
    error: enabled && current ? result.error : undefined,
    refresh: () => setRevision((value) => value + 1),
  };
}
