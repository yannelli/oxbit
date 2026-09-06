import en from "./locales/en.json";
import de from "./locales/de.json";
export type Locale = "en" | "de";
const resources: Record<Locale, Record<string, string>> = { en, de };
let locale: Locale = "en";
export function setLocale(value: string | undefined): void {
  locale = value === "de" || value === "long" ? "de" : "en";
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}
export function getLocale(): Locale {
  return locale;
}
export function getPhrases(): Record<string, string> {
  return resources[locale];
}
export function translate(
  message: string,
  values: Record<string, unknown> = {},
): string {
  const translated =
    resources[locale][message] ?? resources.en[message] ?? message;
  return translated.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder,
  );
}
