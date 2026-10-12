import { createServer } from "node:http";
import type { Loopback, LoopbackRequest, LoopbackServer } from "@oxbit/agent-core";

/** The Sign in with ChatGPT callback listener on 127.0.0.1. Callbacks that arrive before next() wait in a queue. */
export const nodeLoopback: Loopback = {
  listen: (port, path) => new Promise<LoopbackServer>((resolve, reject) => {
    const queued: LoopbackRequest[] = [];
    const waiting = new Set<(request: LoopbackRequest) => void>();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== path) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      let answered = false;
      const request: LoopbackRequest = {
        query: Object.fromEntries(url.searchParams),
        respond(status, html) {
          if (answered) return;
          answered = true;
          res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
        },
      };
      const [waiter] = waiting;
      if (!waiter) return void queued.push(request);
      waiting.delete(waiter);
      waiter(request);
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", () => {});
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        next: (signal) => new Promise((done, fail) => {
          const ready = queued.shift();
          if (ready) return done(ready);
          if (signal.aborted) return fail(new Error("The sign-in was cancelled"));
          const waiter = (request: LoopbackRequest) => {
            signal.removeEventListener("abort", abort);
            done(request);
          };
          const abort = () => {
            waiting.delete(waiter);
            fail(new Error("The sign-in was cancelled"));
          };
          waiting.add(waiter);
          signal.addEventListener("abort", abort, { once: true });
        }),
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  }),
};
