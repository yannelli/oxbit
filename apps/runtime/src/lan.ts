import os from "node:os";
import { execFileSync } from "node:child_process";

type Interfaces = ReturnType<typeof os.networkInterfaces>;

export const wildcardHost = (host: string) => host === "0.0.0.0" || host === "::";
/** Loopback address that reaches a runtime bound to host, for probes and local links. */
export const localHost = (host: string) => (wildcardHost(host) ? "127.0.0.1" : host);
// os.hostname() can be a DNS name such as studio.example.internal; Bonjour serves its first label.
export const localName = (hostname = os.hostname()) => hostname.split(".")[0]!;
let macLocalName: string | undefined;
// macOS publishes LocalHostName over Bonjour, which can differ from os.hostname().
function bonjourName() {
  if (process.platform !== "darwin") return undefined;
  try {
    macLocalName ??= execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 1000 }).trim();
  } catch {
    macLocalName = "";
  }
  return macLocalName || undefined;
}

export function lanAddresses(interfaces: Interfaces = os.networkInterfaces()) {
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal);
  const of = (family: string) => [
    ...new Set(addresses.filter((entry) => entry.family === family).map((entry) => entry.address.split("%")[0]!)),
  ];
  return { v4: of("IPv4"), v6: of("IPv6") };
}

/** Browser origins for a runtime bound to every interface, read when each request arrives. */
export function lanOrigins(port: number, interfaces: Interfaces = os.networkInterfaces(), hostname = os.hostname(), published = bonjourName()) {
  const { v4, v6 } = lanAddresses(interfaces);
  return [
    ...v4.map((address) => `http://${address}:${port}`),
    ...v6.map((address) => `http://[${address}]:${port}`),
    ...new Set([localName(hostname), ...(published ? [published] : [])].map((name) => `http://${name}.local:${port}`)),
  ];
}

export function lanUrl(port: number, interfaces: Interfaces = os.networkInterfaces()) {
  const address = lanAddresses(interfaces).v4[0];
  return address ? `http://${address}:${port}` : undefined;
}
