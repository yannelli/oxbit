import { readFile } from "node:fs/promises";

const locks = process.argv.slice(2);
if (!locks.length) {
  console.error("Usage: node scripts/osv-cargo.mjs <Cargo.lock>...");
  process.exit(2);
}
for (const lock of locks) {
  const crates = new Map();
  for (const block of (await readFile(lock, "utf8")).split("[[package]]").slice(1)) {
    const field = (key) => block.match(new RegExp(`^${key} = "([^"]+)"`, "m"))?.[1];
    if (field("source")?.includes("crates.io")) crates.set(`${field("name")}@${field("version")}`, [field("name"), field("version")]);
  }
  const packages = [...crates.values()].sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  const found = [];
  for (let start = 0; start < packages.length; start += 500) {
    const chunk = packages.slice(start, start + 500);
    const response = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: chunk.map(([name, version]) => ({ package: { name, ecosystem: "crates.io" }, version })) }),
    });
    if (!response.ok) throw new Error(`OSV query failed (${response.status})`);
    const { results } = await response.json();
    results.forEach((result, index) => {
      const ids = (result.vulns ?? []).map((vuln) => vuln.id);
      if (ids.length) found.push(`${chunk[index].join("@")} ${ids.join(", ")}`);
    });
  }
  console.log(`== ${lock}: ${packages.length} crates, ${found.length} with advisories`);
  for (const line of found) console.log(`   ${line}`);
}
