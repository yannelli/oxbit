// Drives a runtime through the iOS tunnel the way the WebView does: authenticate, read a file,
// trust the workspace, and run one terminal command. Prints one JSON line.
import { connect, fail, until } from "./runtime-socket.mjs";

const [url, token, file, command, expected] = process.argv.slice(2);
setTimeout(() => fail("probe timed out"), 60000).unref();
try {
  const { socket, request, events, session } = await connect(url, token);
  const output = () => events.filter((event) => event.event === "terminal.data").map((event) => event.params.data).join("");
  const read = await request("fs.read", { path: file });
  await request("workspace.trust", { trusted: true });
  const terminal = await request("terminal.create", { cols: 80, rows: 24 });
  await request("terminal.input", { id: terminal.id, data: command + "\r" });
  await until(() => output().includes(expected), "terminal output " + JSON.stringify(output().slice(-400)));
  await request("terminal.kill", { id: terminal.id });
  console.log(JSON.stringify({ owner: session.owner, text: read.text, terminal: true }));
  socket.close();
  process.exit(0);
} catch (error) {
  fail(String(error));
}
