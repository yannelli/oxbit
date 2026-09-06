import type { Terminal } from "@xterm/xterm";

export function loadOptionalAddons(terminal: Terminal, isMounted: () => boolean): void {
  void import("@xterm/addon-image")
    .then(({ ImageAddon }) => {
      if (isMounted()) terminal.loadAddon(new ImageAddon({ storageLimit: 32 }));
    })
    .catch(() => {});
  void import("@xterm/addon-ligatures")
    .then(({ LigaturesAddon }) => {
      if (isMounted()) terminal.loadAddon(new LigaturesAddon());
    })
    .catch(() => {});
  if (typeof WebGL2RenderingContext !== "undefined")
    void import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (!isMounted()) return;
        const webgl = new WebglAddon();
        try {
          terminal.loadAddon(webgl);
          webgl.onContextLoss(() => webgl.dispose());
        } catch {
          webgl.dispose();
        }
      })
      .catch(() => {});
}
