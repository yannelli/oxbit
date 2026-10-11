import type { FileEntry, FileSystem } from "@oxbit/sdk";
import { MAX_CHANGES_TEXT } from "./changes.js";

export const MAX_FOLDER_FILES = 500;
const SKIPPED = [".git", "node_modules"];

async function folderFiles(filesystem: FileSystem, folder: string) {
  const files: FileEntry[] = [];
  const pending = [folder];
  let more = false;
  for (let index = 0; index < pending.length && !more; index++) {
    let entries: FileEntry[];
    try {
      entries = await filesystem.list(pending[index]);
    } catch (error) {
      if (!index) throw error;
      continue;
    }
    for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
      if (SKIPPED.includes(entry.name)) continue;
      if (entry.kind === "directory") pending.push(entry.path);
      else if (files.length < MAX_FOLDER_FILES) files.push(entry);
      else more = true;
    }
  }
  return { files, more };
}

/** The folder's file list, then the text of each file that fits in `limit`. Binary files are listed only. */
export async function folderText(filesystem: FileSystem, folder: string, limit = MAX_CHANGES_TEXT) {
  const { files, more } = await folderFiles(filesystem, folder);
  if (!files.length) throw new Error(`${folder} has no files`);
  const list = files.map((file) => file.path).join("\n") + (more ? `\n[more than ${MAX_FOLDER_FILES} files]` : "");
  const sections: string[] = [];
  let size = list.length + 100;
  for (const file of files) {
    if (limit - size < 64) break;
    if (file.size !== undefined && size + file.size > limit) continue;
    let text: string;
    try {
      text = (await filesystem.read(file.path)).text;
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const section = `\n\n--- ${file.path}\n${text}`;
    if (size + section.length > limit) continue;
    size += section.length;
    sections.push(section);
  }
  const count = `${files.length}${more ? "+" : ""} file${files.length === 1 && !more ? "" : "s"}`;
  const head = `Folder ${folder}: ${count}, ${sections.length} with their text below\n\n`;
  return (head + list + sections.join("")).slice(0, limit);
}
