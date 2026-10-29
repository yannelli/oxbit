const DAY = 24 * 60 * 60 * 1000;

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function capitalize(text: string, locale: string) {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** "Today, 12:41 PM", "Yesterday", "Oct 12", or "Oct 12, 2025" in the given locale. */
export function relativeDate(time: number, now = Date.now(), locale = "en") {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (days === 0) {
    const clock = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(time);
    return `${capitalize(relative.format(0, "day"), locale)}, ${clock}`;
  }
  if (days === 1) return capitalize(relative.format(-1, "day"), locale);
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(time);
}
