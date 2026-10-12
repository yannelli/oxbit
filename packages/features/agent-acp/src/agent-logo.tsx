import { OXBIT_AGENT_PROVIDER, OXBIT_CLI_PROVIDER, acpPreset } from "@oxbit/sdk";
import { Icon } from "@oxbit/ui";
import { AGENT_LOGOS } from "./agent-logos.js";

const masks = new Map<string, string>();

/** CSS mask for a provider's ACP Registry icon: a preset's registry entry, or the registry ID itself. Both Oxbit agents use the Oxbit mark. */
export function agentLogoMask(provider: string) {
  if (provider === OXBIT_AGENT_PROVIDER || provider === OXBIT_CLI_PROVIDER) return 'url("/brand/oxbit-mark.svg")';
  const id = acpPreset(provider)?.registryId ?? provider;
  if (!Object.hasOwn(AGENT_LOGOS, id)) return undefined;
  let mask = masks.get(id);
  if (!mask) masks.set(id, (mask = `url("data:image/svg+xml,${encodeURIComponent(AGENT_LOGOS[id]!)}")`));
  return mask;
}

/** The agent's registry icon in the current text color, or the generic agent icon. */
export function AgentLogo({ provider, size = 16 }: { provider: string; size?: number }) {
  const mask = agentLogoMask(provider);
  if (!mask) return <Icon name="agent" size={size} />;
  return (
    <span
      className="acp-agent-logo"
      aria-hidden="true"
      data-agent={provider}
      style={{ width: size, height: size, WebkitMaskImage: mask, maskImage: mask }}
    />
  );
}
