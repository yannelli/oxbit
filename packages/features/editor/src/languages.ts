import {
  languageIdForPath,
  type Kernel,
  type LanguageDefinition,
} from "@zapp/sdk";
export function contributedLanguage(kernel: Kernel, path: string) {
  return kernel.contributions.list("language").find((contribution) => {
    const data = contribution.data as LanguageDefinition;
    return data?.extensions?.some((extension) =>
      path
        .toLowerCase()
        .endsWith(
          extension.startsWith(".")
            ? extension.toLowerCase()
            : "." + extension.toLowerCase(),
        ),
    );
  });
}
export function editorLanguageId(kernel: Kernel, path: string) {
  return (
    (contributedLanguage(kernel, path)?.data as LanguageDefinition | undefined)
      ?.id || languageIdForPath(path)
  );
}
