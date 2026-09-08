export interface ProjectConfiguration {
  schemaVersion: 1;
  id: string;
  root: string;
  name: string;
  notes: string;
  intelligence: { enabled: boolean; exclude: string[]; maxFiles: number; maxFileBytes: number };
  schemas: { catalog: boolean; download: boolean; associations: { url?: string; fileMatch?: string[]; schema?: Record<string, unknown> | boolean }[] };
}
export interface ProjectFile {
  path: string;
  language: string;
  size: number;
  imports: { specifier: string; target?: string; package?: string }[];
  symbols: { name: string; kind: string; line: number }[];
}
export interface ProjectPackage {
  path: string;
  name: string;
  ecosystem: "npm" | "composer";
  dependencies: { name: string; version: string; kind: string }[];
}
export interface ProjectIntelligence {
  schemaVersion: 1;
  projectId: string;
  generatedAt: string;
  files: ProjectFile[];
  packages: ProjectPackage[];
  frameworks: string[];
  warnings: string[];
  truncated: boolean;
}
export interface ProjectInfo {
  configuration: ProjectConfiguration;
  directory: string;
  state: "idle" | "indexing" | "ready" | "disabled" | "failed";
  error?: string;
  generatedAt?: string;
  fileCount: number;
  packageCount: number;
  frameworks: string[];
  warnings: string[];
}
export interface ProjectRelations {
  path: string;
  imports: ProjectFile["imports"];
  importedBy: string[];
  affected: string[];
  related: { path: string; reason: "imports" | "imported by" | "matching test or source" }[];
}
