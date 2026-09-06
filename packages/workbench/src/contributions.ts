import type { Contribution, Kernel } from "@zapp/sdk";
export function documentViewFor(
  kernel: Kernel,
  path: string,
): Contribution | undefined {
  return kernel.contributions.list("documentView").find((contribution) => {
    const data = contribution.data as
      | {
          default?: boolean;
          extensions?: string[];
          matches?: (path: string) => boolean;
        }
      | undefined;
    if (data?.default || !contribution.component) return false;
    try {
      return (
        data?.matches?.(path) ||
        data?.extensions?.some((extension) =>
          path
            .toLowerCase()
            .endsWith(
              extension.startsWith(".")
                ? extension.toLowerCase()
                : "." + extension.toLowerCase(),
            ),
        )
      );
    } catch {
      return false;
    }
  });
}
export function menuContributions(
  kernel: Kernel,
  location: string,
): Contribution[] {
  const counts = new Map<string, number>();
  return kernel.contributions.list("menu").filter((contribution) => {
    if (contribution.location !== location || !contribution.command)
      return false;
    const owner = contribution.owner || contribution.id;
    const count = counts.get(owner) || 0;
    counts.set(owner, count + 1);
    return ["explorer", "tab", "editor", "terminal", "scm", "problem"].includes(
      location,
    )
      ? count < 3
      : true;
  });
}
export function themeVariables(kernel: Kernel): Record<string, string> {
  const theme = kernel.contributions
    .list("theme")
    .find(
      (item) => item.title === kernel.configuration.get("workbench.colorTheme"),
    );
  const variables = (
    theme?.data as { variables?: Record<string, unknown> } | undefined
  )?.variables;
  return Object.fromEntries(
    Object.entries(variables || {}).filter(
      (entry): entry is [string, string] =>
        /^--[\w-]+$/.test(entry[0]) && typeof entry[1] === "string",
    ),
  );
}
