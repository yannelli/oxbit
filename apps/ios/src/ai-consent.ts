import { PROFILE_SCOPE, native } from "@oxbit/host-ios";
import type { AgentModelEndpoint, AgentModels } from "@oxbit/sdk";

export const AI_CONSENT_KEY = "ai-consent";
const ALLOW = "Allow";

const ORIGINS: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  chatgpt: "https://chatgpt.com",
};
const NAMES: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", chatgpt: "ChatGPT" };

/** Matches the Keychain account form `<api> <origin>`. */
export function consentKey({ api, baseUrl }: AgentModelEndpoint) {
  const origin = ORIGINS[api] ?? (baseUrl ? new URL(baseUrl).origin : "");
  return `${api} ${origin}`;
}

function provider({ api, baseUrl }: AgentModelEndpoint) {
  return NAMES[api] ?? (baseUrl ? new URL(baseUrl).host : api);
}

type Ask = (title: string, message: string, choices: string[]) => Promise<string | undefined>;

/** Asks once per endpoint before the first model request from this device (App Review Guideline 5.1.2(i)); a refusal holds until the workspace reopens. */
export function withAiConsent(models: AgentModels, ask: Ask, storage: Pick<typeof native, "storageGet" | "storageSet"> = native): AgentModels {
  let allowed: Promise<Set<string>> | undefined;
  const refused = new Set<string>();
  const pending = new Map<string, Promise<boolean>>();
  const load = () => (allowed ??= storage.storageGet<string[]>(PROFILE_SCOPE, AI_CONSENT_KEY)
    .then((keys) => new Set(Array.isArray(keys) ? keys : []), () => new Set<string>()));

  async function decide(endpoint: AgentModelEndpoint) {
    const key = consentKey(endpoint);
    const keys = await load();
    if (keys.has(key)) return true;
    if (refused.has(key)) return false;
    let answer = pending.get(key);
    if (!answer) {
      const name = provider(endpoint);
      answer = ask(
        `Share data with ${name}?`,
        `Oxbit sends your agent messages, the conversation, the files and diagnostics the agent reads, and, for AI completions, the code around the cursor plus any problems and other open files you turn on in Settings to ${name}. ${name} handles this data under its own privacy policy.`,
        [ALLOW, "Don't Allow"],
      ).then(async (choice) => {
        if (choice !== ALLOW) {
          refused.add(key);
          return false;
        }
        keys.add(key);
        await storage.storageSet(PROFILE_SCOPE, AI_CONSENT_KEY, [...keys]).catch(() => undefined);
        return true;
      }).finally(() => pending.delete(key));
      pending.set(key, answer);
    }
    return answer;
  }

  return {
    keys: models.keys,
    ...(models.chatgpt ? { chatgpt: models.chatgpt } : {}),
    async *stream(request, signal) {
      if (!(await decide(request)))
        throw new Error(`Oxbit did not send this request because sharing data with ${provider(request)} is not allowed. Reopen the workspace to choose again.`);
      signal?.throwIfAborted();
      yield* models.stream(request, signal);
    },
  };
}
