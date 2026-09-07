import { languageForKernel } from "@oxbit/sdk";
import type {
  CodeActionProvider,
  CompletionProvider,
  Contribution,
  DiagnosticsProvider,
  FeatureOptions,
  ProviderCodeAction,
  ProviderCompletion,
  ProviderDiagnostic,
  ProviderDocument,
  SemanticTokensProvider, InlayHintsProvider, NavigationProvider, NavigationKind, LanguageRange, ProviderInlayHint,
} from "@oxbit/sdk";

export function documentLanguage(o: FeatureOptions, path: string): string {
  const document = o.documents.get(path);
  return languageForKernel(o.kernel, path, document?.text.toString().split("\n", 1)[0]).id;
}

export class LanguageProviders {
  private completionOwners = new WeakMap<object, { contribution: Contribution; path: string; version: number }>();
  private hints = new WeakMap<object, { path: string; contribution: Contribution }>();
  private known = new Map<string, unknown>();
  private actions = new WeakMap<
    ProviderCodeAction,
    { owner: string; data: unknown }
  >();
  private requests = new Map<
    string,
    { owner: string; path: string; controller: AbortController }
  >();
  private findings = new Map<string, Map<string, ProviderDiagnostic[]>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private subscriptions: (() => void)[] = [];
  private disposed = false;
  constructor(
    private o: FeatureOptions,
    private changed: () => void,
  ) {
    this.subscriptions.push(
      o.kernel.contributions.subscribe(() => this.refresh()),
      o.kernel.events.on("document.open", ({ path }) => this.schedule(path))
        .dispose,
      o.kernel.events.on("document.change", ({ id }) => {
        const document = [...o.documents.documents.values()].find(
          (item: any) => item.id === id,
        ) as any;
        if (document) {
          for (const paths of this.findings.values())
            paths.delete(document.path);
          this.changed();
          for (const request of this.requests.values())
            if (request.path === document.path) request.controller.abort();
          this.schedule(document.path);
        }
      }).dispose,
      o.kernel.events.on("document.close", () => {
        for (const [path, timer] of this.timers)
          if (!o.documents.get(path)) {
            clearTimeout(timer);
            this.timers.delete(path);
          }
        for (const request of this.requests.values())
          if (!o.documents.get(request.path)) request.controller.abort();
        for (const paths of this.findings.values())
          for (const path of paths.keys())
            if (!o.documents.get(path)) paths.delete(path);
        this.changed();
      }).dispose,
    );
    this.refresh();
  }
  matching(kind: Contribution["kind"], path: string): Contribution[] {
    const language = documentLanguage(this.o, path);
    return this.o.kernel.contributions
      .list(kind)
      .filter((item) => {
        const provider = item.data as { languages?: string[] } | undefined;
        return (
          Array.isArray(provider?.languages) &&
          (provider.languages.includes("*") ||
            provider.languages.includes(language)) &&
          this.o.kernel.context.matches(item.when)
        );
      })
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          (a.order ?? 0) - (b.order ?? 0) ||
          a.id.localeCompare(b.id),
      );
  }
  private refresh() {
    const current = new Map(
      this.o.kernel.contributions
        .list()
        .filter((item) =>
          ["transport", "diagnostics", "completion", "codeAction", "semanticTokens", "inlayHints", "navigation"].includes(
            item.kind,
          ),
        )
        .map((item) => [item.id, item.data]),
    );
    for (const [id, data] of this.known)
      if (current.get(id) !== data) {
        for (const request of this.requests.values())
          if (request.owner === id) request.controller.abort();
        this.findings.delete(id);
      }
    this.known = current;
    for (const document of this.o.documents.documents.values())
      this.schedule(document.path);
    this.changed();
  }
  private schedule(path: string) {
    clearTimeout(this.timers.get(path));
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.diagnose(path);
      }, 75),
    );
  }
  private async document(path: string): Promise<ProviderDocument> {
    const document = await this.o.documents.open(path);
    return {
      id: document.id,
      path,
      text: document.text.toString(),
      version: document.version,
      revision: document.savedRevision,
      language: documentLanguage(this.o, path),
    };
  }
  private async run<T>(
    contribution: Contribution,
    document: ProviderDocument,
    signal: AbortSignal | undefined,
    invoke: (signal: AbortSignal) => T | Promise<T>,
  ): Promise<T> {
    if (this.disposed || signal?.aborted)
      throw new DOMException("Provider request cancelled", "AbortError");
    const id = crypto.randomUUID(),
      controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 10000);
    this.requests.set(id, {
      owner: contribution.id,
      path: document.path,
      controller,
    });
    let onAbort: () => void = () => {};
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => invoke(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          onAbort = () =>
            reject(
              new DOMException(
                "Provider request cancelled or timed out",
                "AbortError",
              ),
            );
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (
        controller.signal.aborted ||
        this.known.get(contribution.id) !== contribution.data ||
        this.o.documents.get(document.path)?.version !== document.version
      )
        throw new Error("Provider response is stale");
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      this.requests.delete(id);
    }
  }
  async semanticTokens(path: string, range: LanguageRange | undefined, signal?: AbortSignal) {
    const contribution = this.matching("semanticTokens", path)[0];
    if (!contribution) return undefined;
    const document = await this.document(path), provider = contribution.data as SemanticTokensProvider;
    return this.run(contribution, document, signal, signal => provider.provideSemanticTokens(document, range, signal));
  }
  async inlayHints(path: string, range: LanguageRange, signal?: AbortSignal) {
    const contribution = this.matching("inlayHints", path)[0];
    if (!contribution) return [];
    const document = await this.document(path), provider = contribution.data as InlayHintsProvider;
    const values = await this.run(contribution, document, signal, signal => provider.provideInlayHints(document, range, signal));
    for (const hint of values) this.hints.set(hint, { path, contribution });
    return values;
  }
  async resolveHint(hint: ProviderInlayHint, signal?: AbortSignal) {
    const source = this.hints.get(hint);
    if (!source || this.known.get(source.contribution.id) !== source.contribution.data) throw new Error("Inlay hint provider was removed");
    const document = await this.document(source.path), provider = source.contribution.data as InlayHintsProvider;
    const resolved = await this.run(source.contribution, document, signal, signal => provider.resolveInlayHint?.(hint, signal) ?? hint);
    this.hints.set(resolved, source); return resolved;
  }
  async locations(path: string, offset: number, operation: NavigationKind, signal?: AbortSignal) {
    const document = await this.document(path);
    const values = await Promise.all(this.matching("navigation", path).filter(item => (item.data as NavigationProvider).operations.includes(operation)).map(contribution => this.run(contribution, document, signal, signal => (contribution.data as NavigationProvider).provideLocations(document, offset, operation, signal))));
    return values.flat();
  }
  async diagnose(path: string) {
    if (this.disposed || !this.o.documents.get(path)) return;
    const document = await this.document(path);
    await Promise.all(
      this.matching("diagnostics", path).map(async (contribution) => {
        const provider = contribution.data as DiagnosticsProvider;
        if (typeof provider.provideDiagnostics !== "function") return;
        try {
          const diagnostics = await this.run(
            contribution,
            document,
            undefined,
            (signal) => provider.provideDiagnostics(document, signal),
          );
          const valid = diagnostics.filter(
            (value) =>
              Number.isInteger(value.from) &&
              Number.isInteger(value.to) &&
              value.from >= 0 &&
              value.to >= value.from &&
              value.to <= document.text.length &&
              typeof value.message === "string" &&
              ["error", "warning", "info", "hint"].includes(value.severity),
          );
          const paths = this.findings.get(contribution.id) ?? new Map();
          paths.set(path, valid);
          this.findings.set(contribution.id, paths);
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError"))
            this.o.workbench.notify(
              `${contribution.title}: ${String(error)}`,
              "error",
            );
        }
      }),
    );
    this.changed();
  }
  diagnostics(): Map<string, ProviderDiagnostic[]> {
    const result = new Map<string, ProviderDiagnostic[]>();
    for (const paths of this.findings.values())
      for (const [path, items] of paths)
        result.set(path, [...(result.get(path) ?? []), ...items]);
    return result;
  }
  ownsCompletion(item: ProviderCompletion) {
    const source = this.completionOwners.get(item);
    return Boolean(source && this.known.get(source.contribution.id) === source.contribution.data && this.o.documents.get(source.path)?.version === source.version);
  }
  async completions(
    path: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<ProviderCompletion[]> {
    const document = await this.document(path),
      result: ProviderCompletion[] = [];
    for (const contribution of this.matching("completion", path)) {
      const provider = contribution.data as CompletionProvider;
      if (typeof provider.provideCompletions !== "function") continue;
      const values = await this.run(contribution, document, signal, (signal) =>
        provider.provideCompletions(document, offset, signal),
      );
      for (const value of values)
        if (
          typeof value.label === "string" &&
          (value.from === undefined ||
            (Number.isInteger(value.from) &&
              value.from >= 0 &&
              value.from <= document.text.length)) &&
          (value.to === undefined ||
            (Number.isInteger(value.to) &&
              value.to >= (value.from ?? 0) &&
              value.to <= document.text.length)) &&
          !result.some(
            (item) =>
              item.label === value.label &&
              item.from === value.from &&
              item.to === value.to,
          )
        )
          { const item = { ...value }; this.completionOwners.set(item, { contribution, path, version: document.version }); result.push(item); }
    }
    return result;
  }
  async codeActions(
    path: string,
    range: { from: number; to: number },
    signal?: AbortSignal,
  ): Promise<{ owner: string; action: ProviderCodeAction }[]> {
    const document = await this.document(path),
      result: { owner: string; action: ProviderCodeAction }[] = [];
    for (const contribution of this.matching("codeAction", path)) {
      const provider = contribution.data as CodeActionProvider;
      if (typeof provider.provideCodeActions !== "function") continue;
      const values = await this.run(contribution, document, signal, (signal) =>
        provider.provideCodeActions(document, range, signal),
      );
      for (const action of values)
        if (typeof action.title === "string") {
          this.actions.set(action, {
            owner: contribution.id,
            data: contribution.data,
          });
          result.push({ owner: contribution.id, action });
        }
    }
    return result;
  }
  ownsAction(owner: string, action: ProviderCodeAction) {
    const source = this.actions.get(action);
    return (
      source?.owner === owner &&
      this.known.has(owner) &&
      source.data === this.known.get(owner)
    );
  }
  dispose() {
    this.disposed = true;
    for (const off of this.subscriptions) off();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const request of this.requests.values()) request.controller.abort();
    this.timers.clear();
    this.requests.clear();
    this.findings.clear();
    this.known.clear();
  }
}
