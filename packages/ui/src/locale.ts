import en from "./locales/en.json";
import de from "./locales/de.json";
import es from "./locales/es.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";
export type Locale = "en" | "de" | "es" | "ja" | "zh";
const aliases: Record<string, Locale> = { long: "de" };
const resources: Record<Locale, Record<string, string>> = { en, de, es, ja, zh };
let locale: Locale = "en";
function resolveLocale(value: string | undefined): Locale {
  const requested = value ? (aliases[value] ?? value) : "en";
  return requested in resources ? (requested as Locale) : "en";
}
export function setLocale(value: string | undefined): void {
  locale = resolveLocale(value);
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
