import { fromFenceOffset, textOffset, textPosition, type CodeFence } from "@oxbit/sdk";

/** In-memory document for one code fence, synced to the fence language's server under a sibling path of its host. */
export interface FenceDocument {
  path: string;
  host: string;
  fence: CodeFence;
  text: string;
  hostText: string;
  version: number;
}

type Position = { line: number; character: number };
const isPosition = (value: any): value is Position => Boolean(value) && Number.isInteger(value.line) && Number.isInteger(value.character);
const isRange = (value: any) => Boolean(value) && isPosition(value.start) && isPosition(value.end);

export function fenceToHost(entry: FenceDocument, position: Position): Position {
  return textPosition(entry.hostText, fromFenceOffset(entry.fence, textOffset(entry.text, position)));
}

/** Maps ranges in a language result from the fence document to the host. Ranges paired with another file's URI keep their positions. */
export function fenceResultToHost<T>(value: T, entry: FenceDocument, fenceUri: string, hostUri: string): T {
  const visit = (node: any, local: boolean): any => {
    if (Array.isArray(node)) return node.map(child => visit(child, local));
    if (!node || typeof node !== "object") return node;
    const uri = node.uri ?? node.targetUri;
    const own = typeof uri === "string" ? uri === fenceUri : local;
    if (own && isRange(node)) return { ...node, start: fenceToHost(entry, node.start), end: fenceToHost(entry, node.end) };
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) result[key] = (key === "uri" || key === "targetUri") && child === fenceUri ? hostUri : visit(child, own);
    return result;
  };
  return visit(value, true);
}
