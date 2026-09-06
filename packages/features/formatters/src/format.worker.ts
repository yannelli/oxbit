import { formatPrettier } from "./prettier";
import { formatTypeScript } from "./typescript";

type Request = {
  provider: "prettier" | "typescript";
  path: string;
  text: string;
  tabSize: number;
  insertSpaces: boolean;
};
const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<Request>) => void;
  postMessage(value: unknown): void;
};
worker.onmessage = (event) => {
  const request = event.data;
  const format =
    request.provider === "typescript" ? formatTypeScript : formatPrettier;
  void format(request.text, request.path, request).then(
    (text) => worker.postMessage({ text }),
    (error) =>
      worker.postMessage({
        error: error instanceof Error ? error.message : String(error),
      }),
  );
};
