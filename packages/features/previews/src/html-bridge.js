// Runs in an opaque sandbox. Only this bundled script is allowed by the preview CSP.
const sourcePath = document.currentScript.dataset.path;
const send = (type, value = {}) => parent.postMessage({ type, path: sourcePath, ...value }, "*");
document.addEventListener("click", event => {
  const link = event.target.closest?.("a, area");
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("data-preview-href");
  if (href !== null) send("oxbit.preview.link", { href });
}, true);
document.addEventListener("submit", event => event.preventDefault(), true);
let scheduled = false;
window.addEventListener("scroll", () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    send("oxbit.preview.scroll", { top: scrollY });
  });
}, { passive: true });
window.addEventListener("message", event => {
  if (event.source !== parent || event.data?.type !== "oxbit.preview.restore") return;
  if (typeof event.data.anchor === "string") document.getElementById(event.data.anchor)?.scrollIntoView();
  else if (Number.isFinite(event.data.top)) window.scrollTo(0, event.data.top);
});
window.addEventListener("load", () => send("oxbit.preview.ready"));
