import { describe, expect, it } from "vitest";
import { nodeLoopback } from "./loopback.js";

describe("nodeLoopback", () => {
  it("serves the callback path on a free port, answers 404 elsewhere, and rejects a taken port", async () => {
    const server = await nodeLoopback.listen(0, "/auth/callback");
    expect(server.port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/other?code=x`)).status).toBe(404);
    const response = fetch(`${base}/auth/callback?code=c1&state=s1`);
    const request = await server.next(new AbortController().signal);
    expect(request.query).toEqual({ code: "c1", state: "s1" });
    await expect(nodeLoopback.listen(server.port, "/auth/callback")).rejects.toThrow(/EADDRINUSE/);
    request.respond(200, "<p>Done</p>");
    await server.close();
    const answered = await response;
    expect([answered.status, await answered.text(), answered.headers.get("content-type")]).toEqual([200, "<p>Done</p>", "text/html; charset=utf-8"]);
  });

  it("queues a callback that arrives before next() and rejects next() on abort", async () => {
    const server = await nodeLoopback.listen(0, "/auth/callback");
    const early = fetch(`http://127.0.0.1:${server.port}/auth/callback?state=early`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const request = await server.next(new AbortController().signal);
    expect(request.query.state).toBe("early");
    request.respond(400, "no");
    expect((await early).status).toBe(400);
    const abort = new AbortController();
    const waiting = server.next(abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow("cancelled");
    await server.close();
  });
});
