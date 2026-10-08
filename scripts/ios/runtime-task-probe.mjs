// Starts a service task through the iOS tunnel, fetches its link, which the runtime rewrites to
// the device's taskForward listener, then stops the task and fetches again. Prints one JSON line.
import { connect, fail, until } from "./runtime-socket.mjs";

const [url, token, name] = process.argv.slice(2);
setTimeout(() => fail("task probe timed out"), 90000).unref();
try {
  const { socket, request } = await connect(url, token);
  await request("workspace.trust", { trusted: true });
  const task = (await request("tasks.catalog")).tasks.find((entry) => entry.name === name);
  if (!task) fail(`task ${name} is not in the catalog`);
  const started = await request("tasks.start", { taskId: task.id });
  const current = async () => (await request("tasks.list")).find((run) => run.id === started.id);
  const ready = await until(async () => {
    const run = await current();
    if (run?.state === "failed") fail("task failed: " + JSON.stringify(run));
    return run?.state === "ready" && run.links.length > 0 && run;
  }, "task readiness", 45000);
  const link = ready.links.find((entry) => new URL(entry).hostname === "127.0.0.1");
  const body = await (await fetch(link, { signal: AbortSignal.timeout(10000) })).text();
  await request("tasks.stop", { id: started.id });
  await until(async () => ["stopped", "completed", "failed"].includes((await current())?.state), "task stop");
  const after = await fetch(link, { signal: AbortSignal.timeout(5000) })
    .then((response) => `answered ${response.status}`, () => "closed");
  console.log(JSON.stringify({ link, body, after }));
  socket.close();
  process.exit(0);
} catch (error) {
  fail(String(error));
}
