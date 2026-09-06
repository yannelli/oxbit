import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { RuntimeExtensions } from "../src/extensions.js";
import { WorkspaceFiles } from "../src/filesystem.js";
import { importMapHashes } from "../src/runtime.js";

describe("trusted runtime extension host", () => {
  const roots: string[] = [],
    hosts: RuntimeExtensions[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const root of roots.splice(0))
      await fs.rm(root, { recursive: true, force: true });
  });
  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zapp-extension-"));
    roots.push(root);
    const host = new RuntimeExtensions(new WorkspaceFiles(root));
    hosts.push(host);
    return { root, host };
  }
  it("loads a local ESM artifact, exposes filesystem services and disposes every activation", async () => {
    const { root, host } = await setup();
    await fs.writeFile(path.join(root, "note.txt"), "real filesystem");
    await fs.writeFile(
      path.join(root, "extension.mjs"),
      `import {appendFileSync} from 'node:fs';export default {manifest:{manifestVersion:1,id:'test.runtime',name:'Runtime test',version:'1.0.0',sdk:'^1.0.0',environments:['runtime'],activation:['*'],capabilities:['filesystem.read']},activate(ctx){ctx.own(ctx.commands.register({id:'test.runtime.read',title:'Read',run:()=>ctx.services.get('filesystem').read('note.txt')}));ctx.own(ctx.contributions.register({id:'test.runtime.status',kind:'statusItem',title:'Runtime ready'}));ctx.own({dispose(){appendFileSync(ctx.services.get('runtime.workspace').root+'/disposed.txt','disposed\\n');}});}};`,
    );
    expect(await host.load("extension.mjs")).toEqual({ id: "test.runtime" });
    expect(
      (
        (await host.kernel.commands.execute("test.runtime.read")) as {
          text: string;
        }
      ).text,
    ).toBe("real filesystem");
    expect(host.list()[0]?.state).toBe("active");
    await host.disable("test.runtime");
    expect(host.kernel.commands.list()).toHaveLength(0);
    expect(host.kernel.contributions.list()).toHaveLength(0);
    expect(await fs.readFile(path.join(root, "disposed.txt"), "utf8")).toBe(
      "disposed\n",
    );
    await host.activate("test.runtime");
    await host.remove("test.runtime");
    expect(host.list()).toEqual([]);
    expect(await fs.readFile(path.join(root, "disposed.txt"), "utf8")).toBe(
      "disposed\ndisposed\n",
    );
  });
  it("rejects paths outside the workspace and recovers failed activation", async () => {
    const { root, host } = await setup();
    await expect(host.load("../outside.mjs")).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
    await fs.writeFile(path.join(root, "state.txt"), "fail");
    await fs.writeFile(
      path.join(root, "recover.mjs"),
      `export default {manifest:{manifestVersion:1,id:'test.recover',name:'Recovery test',version:'1.0.0',sdk:'^1.0.0',environments:['runtime'],activation:['*'],capabilities:['filesystem.read']},async activate(ctx){ctx.own(ctx.commands.register({id:'test.recover.command',title:'Recovered',run:()=>true}));if((await ctx.services.get('filesystem').read('state.txt')).text==='fail')throw new Error('Activation fixture failure');}};`,
    );
    await expect(host.load("recover.mjs")).rejects.toThrow(
      "Activation fixture failure",
    );
    expect(host.list()[0]?.state).toBe("failed");
    expect(host.kernel.commands.list()).toHaveLength(0);
    await fs.writeFile(path.join(root, "state.txt"), "ready");
    await host.activate("test.recover");
    expect(await host.kernel.commands.execute("test.recover.command")).toBe(
      true,
    );
    await host.suspend();
    expect(host.list()[0]?.state).toBe("disabled");
  });
  it("allows only the exact inline importmap through a content hash", () => {
    const source = '{"imports":{"react":"/sdk/react.js"}}',
      html = `<script type="importmap">${source}</script><script>alert(1)</script>`;
    expect(importMapHashes(html)).toEqual([
      `'sha256-${createHash("sha256").update(source).digest("base64")}'`,
    ]);
  });
});
