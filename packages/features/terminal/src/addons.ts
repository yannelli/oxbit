import type { Terminal } from "@xterm/xterm";
import { loadWebglRenderer } from "./webgl.js";

export function loadOptionalAddons(terminal: Terminal, isMounted: () => boolean) {
  let ligatures: {dispose():void}|undefined; let enabled=false; let generation=0;
  const setLigatures=(value:boolean)=>{if(value===enabled)return;enabled=value;const current=++generation;ligatures?.dispose();ligatures=undefined;if(value)void import("@xterm/addon-ligatures").then(({LigaturesAddon})=>{if(isMounted()&&enabled&&current===generation){ligatures=new LigaturesAddon();terminal.loadAddon(ligatures as any);}}).catch(()=>{});};
  void import("@xterm/addon-image")
    .then(({ ImageAddon }) => {
      if (isMounted()) terminal.loadAddon(new ImageAddon({ storageLimit: 32 }));
    })
    .catch(() => {});
  loadWebglRenderer(terminal, isMounted);
  return {setLigatures};
}
