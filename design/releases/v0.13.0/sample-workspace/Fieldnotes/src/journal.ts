type JournalEntry = {
  place: string;
  date: string;
  moment: string;
  tags: string[];
};

const entries: JournalEntry[] = [
  {
    place: "Harbor walk",
    date: "October 2, 2026",
    moment: "The sky turned the water to silver.",
    tags: ["coast", "morning"],
  },
  {
    place: "Alder Street",
    date: "October 1, 2026",
    moment: "Found a book with a map inside.",
    tags: ["city", "books"],
  },
];

export function findMoments(tag: string): string[] {
  return entries
    .filter((entry) => entry.tags.includes(tag))
    .map((entry) => `${entry.place}: ${entry.moment}`);
}
