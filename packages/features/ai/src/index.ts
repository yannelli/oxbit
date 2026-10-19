import type { EditorView } from "@codemirror/view";
import {
  AGENT_MODELS_SERVICE,
  languageForKernel,
  lspGlobMatches,
  type AgentModels,
  type EditorDecorationContribution,
  type Extension,
  type FeatureOptions,
} from "@oxbit/sdk";
import { AI_SETTINGS, aiConfiguration } from "./configuration.js";
import { ghostText, requestSuggestion } from "./ghost.js";
import { editMarks, inlineEditExtension, runInlineEdit } from "./inline-edit.js";
import { CHARS_PER_TOKEN, cleanCompletion, completionPrompt, completionSystem, contextWindow, nearbyProblems, openFileContext, type OpenFile } from "./prompt.js";
import { AI_PROVIDER_NAMES, AI_SERVICE, RUNTIME_PROVIDERS, aiEndpoint, aiProvider, createAiService } from "./service.js";
import { modelSuggestions } from "./suggestions.js";

export { AI_SETTINGS, aiConfiguration } from "./configuration.js";
export { AI_SERVICE, AI_UNAVAILABLE, aiProvider, createAiService, type AiProvider, type AiRequest, type AiService } from "./service.js";
export { modelSuggestions } from "./suggestions.js";

const SETTINGS = new Map(aiConfiguration.map((setting) => [setting.id, setting]));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createFeature({ kernel, runtime, workbench, documents }: Pick<FeatureOptions, "kernel" | "runtime" | "workbench" | "documents">): Extension {
  const service = createAiService(kernel, runtime);
  let reported: string | undefined;
  const report = (error: unknown) => {
    const text = message(error);
    if (text === reported) return;
    reported = text;
    workbench.notify(`AI completion failed: ${text}`, "error", { source: "AI" });
  };
  const activeView = () => workbench.activeEditor() as EditorView | undefined;
  const diagnostics = new Map<string, unknown[]>();
  /** The setting for `language`, rounded and held to the setting's range. */
  const limit = (id: string, language: string) => {
    const spec = SETTINGS.get(id)!, value = kernel.configuration.get<number>(id, language);
    const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : spec.default as number;
    return Math.min(spec.max ?? number, Math.max(spec.min ?? number, number));
  };
  const excluded = (path: string, language: string) =>
    (kernel.configuration.get<string[]>(AI_SETTINGS.disabledGlobs, language) ?? []).some((pattern) => lspGlobMatches(pattern, path));
  const otherOpenFiles = (path: string, language: string): OpenFile[] => {
    const open = (documents as { documents?: Map<string, { text: { toString(): string } }> } | undefined)?.documents;
    return [...open?.entries() ?? []].reverse()
      .filter(([other]) => other !== path && !excluded(other, language))
      .map(([other, handle]) => ({ path: other, text: handle.text.toString() }));
  };
  return {
    manifest: {
      manifestVersion: 1,
      id: "oxbit.ai",
      name: "AI Editing",
      description: "Ghost text completions and inline edits from the Oxbit agent, OpenRouter, a custom OpenAI API, or a local model.",
      version: "1.0.0",
      sdk: "^1.0.0",
      environments: ["browser", "embedded"],
      activation: ["*"],
      capabilities: [],
      configuration: aiConfiguration,
    },
    activate(ctx) {
      ctx.own(ctx.services.register(AI_SERVICE, service));
      ctx.own(kernel.events.on("diagnostics.change", ({ path, diagnostics: items }) => {
        if (items.length) diagnostics.set(path, items);
        else diagnostics.delete(path);
      }));
      const decoration: EditorDecorationContribution = {
        createExtensions: ({ path }) => {
          const language = languageForKernel(kernel, path).id;
          return [
            ghostText({
              automatic: () => kernel.configuration.get<boolean>(AI_SETTINGS.inlineCompletions, language) === true && !excluded(path, language),
              delay: () => kernel.configuration.get<number>(AI_SETTINGS.delay, language) ?? 350,
              async suggest(doc, pos, signal) {
                if (excluded(path, language)) return "";
                const flag = (id: string) => kernel.configuration.get<boolean>(id, language);
                const tokens = limit(AI_SETTINGS.contextTokens, language), maxLines = limit(AI_SETTINGS.maxLines, language);
                const openFiles = flag(AI_SETTINGS.includeOpenFiles) === true ? openFileContext(otherOpenFiles(path, language), Math.floor(tokens / 4)) : [];
                const openChars = openFiles.reduce((sum, file) => sum + file.text.length, 0);
                const window = contextWindow(doc, pos, {
                  linesBefore: limit(AI_SETTINGS.linesBefore, language),
                  linesAfter: limit(AI_SETTINGS.linesAfter, language),
                  tokens: tokens - Math.ceil(openChars / CHARS_PER_TOKEN),
                });
                const problems = flag(AI_SETTINGS.includeDiagnostics) === true ? nearbyProblems(diagnostics.get(path) ?? [], window.firstLine, window.lastLine) : [];
                const context = { prefix: window.prefix, suffix: window.suffix };
                const reply = await service.complete({
                  system: completionSystem({ maxLines, instructions: kernel.configuration.get<string>(AI_SETTINGS.instructions, language) }),
                  prompt: completionPrompt({ path, language, ...context, includePath: flag(AI_SETTINGS.includePath) !== false, problems, openFiles }),
                  maxTokens: limit(AI_SETTINGS.maxTokens, language),
                }, signal);
                reported = undefined;
                return cleanCompletion(reply, context, maxLines);
              },
              onError: report,
            }),
            inlineEditExtension,
          ];
        },
      };
      ctx.own(ctx.contributions.register({ id: "oxbit.ai.editor", kind: "editorDecoration", title: "AI Editing", data: decoration }));
      ctx.own(ctx.contributions.register({ id: "oxbit.ai.models", kind: "settingSuggestions", title: "AI models", data: modelSuggestions(kernel, runtime) }));
      ctx.own(ctx.commands.register({
        id: "ai.setApiKey",
        title: "Set AI Provider API Key",
        category: "AI",
        async run() {
          const provider = aiProvider(kernel);
          if (provider === "agent" || provider === "local") {
            workbench.notify(provider === "agent" ? "The agent provider uses the key from Agent setup." : "The local provider sends no key.", "info", { ttl: 4000, source: "AI" });
            return;
          }
          try {
            const endpoint = aiEndpoint(kernel, provider);
            const key = (await workbench.prompt(`API key for ${AI_PROVIDER_NAMES[provider]}`))?.trim();
            if (!key) return;
            const models = kernel.services.optional<AgentModels>(AGENT_MODELS_SERVICE);
            if (models) await models.keys.save(endpoint, key);
            else if (runtime?.connected) await runtime.request("ai.key", { operation: "save", provider: RUNTIME_PROVIDERS[provider], baseUrl: endpoint.baseUrl, key });
            else throw new Error("Connect to a runtime to save the key");
            workbench.notify(`Saved the API key for ${AI_PROVIDER_NAMES[provider]}.`, "info", { ttl: 4000, source: "AI" });
          } catch (error) {
            workbench.notify(`Could not save the API key: ${message(error)}`, "error", { source: "AI" });
          }
        },
      }));
      ctx.own(ctx.commands.register({
        id: "ai.inlineEdit",
        title: "Edit Selection with AI",
        category: "AI",
        when: "editor",
        shortcut: "Ctrl+Alt+K",
        async run() {
          const view = activeView(), path = workbench.activePath();
          if (!view || !path || !view.state.field(editMarks, false)) return;
          const empty = view.state.selection.main.empty;
          const instruction = (await workbench.prompt(empty ? "Describe the code to insert" : "Describe the change to the selection"))?.trim();
          view.focus();
          if (!instruction) return;
          try {
            const isolateUndo = () => documents?.get?.(path)?.undo?.stopCapturing?.();
            if (await runInlineEdit({ view, service, instruction, path, language: languageForKernel(kernel, path).id, isolateUndo }))
              workbench.notify("AI edit applied. Undo reverts it.", "info", { ttl: 4000, source: "AI" });
          } catch (error) {
            workbench.notify(`AI edit failed: ${message(error)}`, "error", { source: "AI" });
          }
        },
      }));
      ctx.own(ctx.commands.register({
        id: "ai.suggestInline",
        title: "Suggest Inline Completion",
        category: "AI",
        when: "editor",
        run() {
          const view = activeView();
          if (view) requestSuggestion(view);
        },
      }));
      ctx.own(ctx.commands.register({
        id: "ai.toggleInlineCompletions",
        title: "Toggle Inline Completions",
        category: "AI",
        run() {
          const enabled = kernel.configuration.get<boolean>(AI_SETTINGS.inlineCompletions) === true;
          kernel.configuration.set(AI_SETTINGS.inlineCompletions, !enabled);
          workbench.notify(`AI inline completions ${enabled ? "off" : "on"}`, "info", { ttl: 2500, source: "AI" });
        },
      }));
    },
  };
}
