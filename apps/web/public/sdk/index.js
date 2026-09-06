export const SDK_VERSION = "1.0.0";
export function languageIdForPath(path) {
    const extension = path.split(".").pop()?.toLowerCase();
    if (extension === "tsx")
        return "tsx";
    if (["ts", "mts", "cts"].includes(extension ?? ""))
        return "typescript";
    if (["js", "jsx", "mjs", "cjs"].includes(extension ?? ""))
        return "javascript";
    if (["md", "markdown"].includes(extension ?? ""))
        return "markdown";
    if (["html", "htm"].includes(extension ?? ""))
        return "html";
    if (["json", "css"].includes(extension ?? ""))
        return extension;
    return "plaintext";
}
