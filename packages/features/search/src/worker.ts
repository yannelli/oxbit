import { searchText, type SearchMatch, type SearchOptions } from "./engine";
self.onmessage = (
  event: MessageEvent<{
    id: string;
    files: { path: string; text: string; revision: string; version?: number }[];
    options: SearchOptions;
  }>,
) => {
  const { id, files, options } = event.data;
  try {
    const results: SearchMatch[] = [];
    for (const file of files) {
      results.push(
        ...searchText(
          file.path,
          file.text,
          file.revision,
          options,
          file.version,
        ).slice(0, 10000 - results.length),
      );
      if (results.length >= 10000) break;
    }
    self.postMessage({
      id,
      results,
    });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
