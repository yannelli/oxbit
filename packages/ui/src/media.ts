import { useEffect, useState } from "react";

export const PHONE_QUERY = "(max-width: 599px)";
export const TOUCH_QUERY = "(pointer: coarse)";

const matches = (query: string) =>
  typeof matchMedia === "function" && matchMedia(query).matches;

export function useMedia(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);
    const update = () => setValue(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return value;
}

export const usePhone = () => useMedia(PHONE_QUERY);
export const useTouch = () => useMedia(TOUCH_QUERY);

export function displayShortcut(key: string | undefined): string {
  if (!key) return "";
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);
  return mac
    ? key
        .replace(/Ctrl\+|Mod\+/g, "⌘")
        .replace(/Shift\+/g, "⇧")
        .replace(/Alt\+/g, "⌥")
        .replace(/ArrowRight/g, "→")
        .replace(/ArrowLeft/g, "←")
        .replace(/Enter/g, "↩︎")
    : key.replace(/Mod/g, "Ctrl");
}
