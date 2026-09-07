export interface Profile {
  user: Record<string, unknown>;
  userLanguages: Record<string, Record<string, unknown>>;
}
export interface SettingChange {
  path: string[];
  value?: unknown;
}
export function profileChanges(
  before: Profile,
  after: Profile,
): SettingChange[] {
  const changes: SettingChange[] = [];
  const compare = (
    prefix: string[],
    a: Record<string, unknown> = {},
    b: Record<string, unknown> = {},
  ) => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
        changes.push({ path: [...prefix, key], value: b[key] });
  };
  compare(["user"], before.user, after.user);
  for (const language of new Set([
    ...Object.keys(before.userLanguages),
    ...Object.keys(after.userLanguages),
  ]))
    compare(
      ["userLanguages", language],
      before.userLanguages[language],
      after.userLanguages[language],
    );
  return changes;
}
