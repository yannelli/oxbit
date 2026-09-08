import { languageForKernel, type Kernel } from "@oxbit/sdk";
export function contributedLanguage(kernel: Kernel, path: string) {
  const definition = languageForKernel(kernel, path);
  return kernel.contributions.list("language").find(item => item.data === definition);
}
export function editorLanguageId(kernel: Kernel, path: string) {
  return languageForKernel(kernel, path).id;
}
