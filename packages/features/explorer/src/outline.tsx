import { Icon, IconButton, translate as tr } from "@oxbit/ui";
import {
  symbolKind,
  useDocumentSymbols,
  type WorkbenchController,
} from "@oxbit/workbench";

export function Outline({ workbench }: { workbench: WorkbenchController }) {
  const { items, path, loading, error, refresh } =
    useDocumentSymbols(workbench);
  return (
    <div className="document-outline" aria-busy={loading}>
      <div className="outline-toolbar">
        <span>{path?.split("/").pop() ?? tr("No file open")}</span>
        <IconButton
          icon="refresh"
          label={tr("Refresh symbols")}
          onClick={refresh}
          disabled={!path}
        />
      </div>
      {loading ? (
        <p className="outline-message" role="status">
          {tr("Loading symbols…")}
        </p>
      ) : error ? (
        <p className="outline-message" role="status">
          {tr(error)}
        </p>
      ) : !items.length ? (
        <p className="outline-message">
          {tr(
            path
              ? "No symbols in this file."
              : "Open a code file to see its outline.",
          )}
        </p>
      ) : (
        <nav aria-label={tr("Document symbols")}>
          {items.map((symbol, index) => (
            <button
              key={`${symbol.path}:${index}`}
              className="outline-symbol"
              style={{ paddingLeft: 12 + Math.min(symbol.depth, 8) * 12 }}
              onClick={() =>
                void workbench.openFile(symbol.path, {
                  line: symbol.selectionRange.start.line + 1,
                  col: symbol.selectionRange.start.character + 1,
                })
              }
            >
              <Icon name="symbol" size={14} />
              <span>{symbol.name}</span>
              <small>{tr(symbolKind(symbol.kind))}</small>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
