export type PreviewLink =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string; anchor?: string }
  | { kind: "blocked"; reason: string };
export type PreviewResourceTrust = "local" | "external";

export function externalPreviewResource(href: string, trust: PreviewResourceTrust): string | undefined {
  if (trust !== "external") return;
  const value = href.trim();
  if (value.includes("\\") || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password)
      return url.href;
  } catch { return; }
}

export function previewResourcePolicy(trust: PreviewResourceTrust): string {
  const sources = trust === "external" ? "data: https: http:" : "data:";
  return `style-src 'unsafe-inline' ${sources}; img-src ${sources}; font-src ${sources}; media-src ${sources}`;
}

export function resolvePreviewLink(
  sourcePath: string,
  href: string,
): PreviewLink {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.trim());
  } catch {
    return { kind: "blocked", reason: "Invalid link encoding" };
  }
  if (
    !decoded ||
    decoded.includes("\\") ||
    [...decoded].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return { kind: "blocked", reason: "Invalid link characters" };
  if (decoded.startsWith("#")) return { kind: "anchor", id: decoded.slice(1) };
  if (/^https?:\/\//i.test(decoded)) {
    try {
      const url = new URL(decoded);
      if (url.username || url.password)
        return {
          kind: "blocked",
          reason: "Links with credentials are blocked",
        };
      return { kind: "external", url: url.href };
    } catch {
      return { kind: "blocked", reason: "Invalid web link" };
    }
  }
  if (/^mailto:/i.test(decoded)) return { kind: "external", url: decoded };
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith("//"))
    return { kind: "blocked", reason: "Unsupported link protocol" };
  const [relative, anchor] = decoded.split("#");
  const base = relative!.startsWith("/")
    ? []
    : sourcePath.split("/").slice(0, -1);
  for (const part of relative!.split("?")[0]!.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!base.length)
        return { kind: "blocked", reason: "Link leaves the workspace" };
      base.pop();
    } else base.push(part);
  }
  if (!base.length)
    return { kind: "blocked", reason: "Link does not name a workspace file" };
  return { kind: "file", path: base.join("/"), ...(anchor ? { anchor } : {}) };
}
export function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-") || "section"
  );
}
export function scrollFraction(element: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  return Math.max(
    0,
    Math.min(
      1,
      element.scrollTop /
        Math.max(1, element.scrollHeight - element.clientHeight),
    ),
  );
}
