/** Web globals for a bare JavaScriptCore context. Swift installs the `__oxbit*` functions before evaluation. */
declare const __oxbitSetTimer: (callback: () => void, milliseconds: number) => number;
declare const __oxbitClearTimer: (id: number) => void;
declare const __oxbitNow: () => number;
declare const __oxbitLog: (level: string, message: string) => void;

const scope = globalThis as any;
if (typeof scope.setTimeout !== "function" && typeof __oxbitSetTimer === "function") {
  scope.setTimeout = (callback: (...args: unknown[]) => void, milliseconds = 0, ...args: unknown[]) => __oxbitSetTimer(() => callback(...args), Number(milliseconds) || 0);
  scope.clearTimeout = (id?: number) => { if (id !== undefined) __oxbitClearTimer(id); };
  scope.setInterval = (callback: (...args: unknown[]) => void, milliseconds = 0, ...args: unknown[]) => {
    const handle = { id: 0 };
    const tick = () => { handle.id = __oxbitSetTimer(tick, Number(milliseconds) || 0); callback(...args); };
    handle.id = __oxbitSetTimer(tick, Number(milliseconds) || 0);
    return handle;
  };
  scope.clearInterval = (handle?: { id: number }) => { if (handle) __oxbitClearTimer(handle.id); };
  scope.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => scope.setTimeout(callback, 0, ...args);
  scope.clearImmediate = scope.clearTimeout;
}
scope.queueMicrotask ??= (callback: () => void) => { void Promise.resolve().then(callback); };
scope.self ??= scope;
scope.performance ??= { now: () => typeof __oxbitNow === "function" ? __oxbitNow() : Date.now() };
if (!scope.console && typeof __oxbitLog === "function") {
  const log = (level: string) => (...values: unknown[]) => __oxbitLog(level, values.map(String).join(" "));
  scope.console = { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: () => {}, trace: () => {} };
}
scope.process ??= { browser: true, env: {}, platform: "ios", cwd: () => "/", nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => scope.queueMicrotask(() => callback(...args)), versions: {} };

if (typeof scope.TextEncoder !== "function") {
  scope.TextEncoder = class TextEncoder {
    readonly encoding = "utf-8";
    encode(text = ""): Uint8Array {
      const bytes: number[] = [];
      for (let index = 0; index < text.length; index++) {
        let code = text.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
          const next = text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00); index++; }
        }
        if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
        else if (code < 0x10000) bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
        else bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
      }
      return new Uint8Array(bytes);
    }
    encodeInto(text: string, target: Uint8Array) {
      const bytes = this.encode(text), written = Math.min(bytes.length, target.length);
      target.set(bytes.subarray(0, written));
      return { read: text.length, written };
    }
  };
}
if (typeof scope.TextDecoder !== "function") {
  scope.TextDecoder = class TextDecoder {
    readonly encoding = "utf-8";
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return "";
      const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      const units: number[] = [];
      let text = "";
      for (let index = 0; index < bytes.length;) {
        const byte = bytes[index];
        const length = byte < 0x80 ? 1 : byte >= 0xf0 && byte < 0xf8 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 0;
        let code = length === 1 ? byte : length === 2 ? byte & 31 : length === 3 ? byte & 15 : byte & 7;
        let valid = length > 0 && index + length <= bytes.length;
        for (let offset = 1; valid && offset < length; offset++) {
          const next = bytes[index + offset];
          if ((next & 0xc0) !== 0x80) valid = false;
          else code = code << 6 | next & 63;
        }
        if (!valid) { units.push(0xfffd); index++; }
        else {
          if (code >= 0x10000) { code -= 0x10000; units.push(0xd800 + (code >> 10), 0xdc00 + (code & 1023)); }
          else units.push(code);
          index += length;
        }
        if (units.length >= 8192) { text += String.fromCharCode(...units); units.length = 0; }
      }
      return text + String.fromCharCode(...units);
    }
  };
}
export {};
