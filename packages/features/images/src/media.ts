/** Types the browser can draw in an <img> element, which decodes off the main thread. */
export const imageTypes: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jfif: "image/jpeg",
  jpe: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};
export const imageExtensions = Object.keys(imageTypes);
export function mimeForPath(path: string): string | undefined {
  const name = path.toLowerCase().split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? imageTypes[name.slice(dot + 1)] : undefined;
}
export function isVector(path: string): boolean {
  return mimeForPath(path) === "image/svg+xml";
}
export const zoomSteps = [
  0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16,
];
export function nextZoom(scale: number, direction: 1 | -1): number {
  const lowest = zoomSteps[0]!;
  const highest = zoomSteps[zoomSteps.length - 1]!;
  if (direction > 0)
    return zoomSteps.find((step) => step > scale + 1e-6) ?? Math.max(scale, highest);
  return (
    [...zoomSteps].reverse().find((step) => step < scale - 1e-6) ??
    Math.min(scale, lowest)
  );
}
export interface Size {
  width: number;
  height: number;
}
/** Fit shrinks an oversized image and leaves a smaller one at its own size. */
export function fitScale(natural: Size, viewport: Size): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(
    1,
    viewport.width / natural.width,
    viewport.height / natural.height,
  );
}
export function formatBytes(value: number): string {
  const units = ["B", "KB", "MB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}
export function formatZoom(scale: number): string {
  const percent = scale * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}
