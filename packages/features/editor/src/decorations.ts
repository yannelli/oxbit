import type { EditorDecorationContribution, Kernel } from "@oxbit/sdk";
import type { Extension } from "@codemirror/state";
export function contributedDecorations(
  kernel: Kernel,
  document: { id: string; path: string },
  onError: (message: string) => void = () => {},
): Extension[] {
  return kernel.contributions
    .list("editorDecoration")
    .flatMap((contribution) => {
      try {
        const data = contribution.data as
          EditorDecorationContribution | undefined;
        return [
          ...(data?.extensions || []),
          ...(data?.createExtensions?.(document) || []),
        ] as Extension[];
      } catch (error) {
        onError(
          `${contribution.title}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    });
}
