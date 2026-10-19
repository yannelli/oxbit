import type { Terminal } from "@xterm/xterm";

export function loadWebglRenderer(terminal: Terminal, isMounted: () => boolean) {
  // WebKit caps live WebGL contexts, so a lost or refused context retries when the user focuses this terminal again.
  let webgl: {dispose():void}|undefined; let loading=false;
  const loadWebgl=()=>{if(webgl||loading||!isMounted())return;loading=true;void import("@xterm/addon-webgl").then(({WebglAddon})=>{if(!isMounted())return;const addon=new WebglAddon();try{terminal.loadAddon(addon);webgl=addon;addon.onContextLoss(()=>{addon.dispose();if(webgl===addon)webgl=undefined;});}catch{addon.dispose();}}).catch(()=>{}).finally(()=>{loading=false;});};
  if (typeof WebGL2RenderingContext !== "undefined") {
    loadWebgl();
    terminal.textarea?.addEventListener("focus", loadWebgl);
  }
}
