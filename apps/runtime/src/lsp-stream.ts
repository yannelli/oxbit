import { Transform, type TransformCallback } from "node:stream";
/** Bound headers/bodies before vscode-jsonrpc buffers them. JSON framing and decoding stay in that library. */
export class BoundedLspStream extends Transform {
  private header = "";
  private remaining = 0;
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      for (let at = 0; at < chunk.length;) {
        if (this.remaining) { const bytes = Math.min(this.remaining, chunk.length - at); at += bytes; this.remaining -= bytes; continue; }
        this.header += String.fromCharCode(chunk[at++]);
        if (this.header.length > 8192) throw new Error("Language server header exceeds 8 KiB");
        if (this.header.endsWith("\r\n\r\n")) {
          const lines = this.header.slice(0, -4).split("\r\n");
          if (lines.some(line => !/^[\w-]+:[^\r\n]*$/.test(line)) || lines.filter(line => /^Content-Length:/i.test(line)).length !== 1) throw new Error("Malformed language server header");
          const length = /^Content-Length:\s*(\d+)\s*$/im.exec(this.header);
          if (!length || Number(length[1]) > 16 * 1024 * 1024 || Number(length[1]) < 1) throw new Error("Invalid or oversized language server message");
          this.remaining = Number(length[1]); this.header = "";
        }
      }
      callback(null, chunk);
    } catch (error) { callback(error as Error); }
  }
}
