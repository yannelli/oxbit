import type { RateLimiter } from "./cloudflare.js";

/** Rate-limit key for `CF-Connecting-IP`: the IPv4 address, or the IPv6 /64 prefix. */
export function rateLimitKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** True when the binding exists and refuses the caller. */
export async function overLimit(limiter: RateLimiter | undefined, request: Request): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key: rateLimitKey(request.headers.get("CF-Connecting-IP")) });
  return !success;
}

function ipv6Groups(address: string): number[] | null {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const left = parseGroups(halves[0], halves.length === 1);
  const right = halves.length === 2 ? parseGroups(halves[1], true) : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function parseGroups(text: string, allowIpv4Tail: boolean): number[] | null {
  if (text === "") return [];
  const pieces = text.split(":");
  const groups: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (allowIpv4Tail && index === pieces.length - 1 && piece.includes(".")) {
      const octets = piece.split(".").map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : NaN));
      if (octets.length !== 4 || octets.some((octet) => !(octet <= 255))) return null;
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
      groups.push(parseInt(piece, 16));
    } else {
      return null;
    }
  }
  return groups;
}
