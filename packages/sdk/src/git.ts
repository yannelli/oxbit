export interface GitChange {
  path: string;
  originalPath?: string;
  index: string;
  working: string;
  conflict?: boolean;
}
export interface GitBranch {
  name: string;
  ref: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
  commit: string;
  subject: string;
}
export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}
export interface GitStatus {
  repository: boolean;
  branch: string;
  branches: string[];
  refs: GitBranch[];
  changes: GitChange[];
  remotes: GitRemote[];
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  operation?: "merge" | "rebase" | "cherry-pick" | "revert";
}
export interface GitCommit {
  id: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  body: string;
  refs: string;
}
export interface GitLog {
  commits: GitCommit[];
  hasMore: boolean;
}
export interface GitCommitFile {
  path: string;
  originalPath?: string;
  status: string;
}
export interface GitCommitDetail {
  commit: GitCommit;
  files: GitCommitFile[];
}
export interface GitStash {
  id: string;
  ref: string;
  message: string;
  date: string;
}
export interface GitDiff {
  before: string;
  after: string;
  diff: string;
  binary?: boolean;
  fingerprint?: string;
  hunks?: { index: number; header: string; patch: string }[];
}
