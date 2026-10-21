import { tryRun } from './exec.mjs';

const FIELDS = 'number,title,headRefName,url,updatedAt';

export function staleWork({ root, env, timeoutMs = 10000, limit = 30 }) {
  const options = { cwd: root, env, timeoutMs };
  const list = tryRun('gh', ['pr', 'list', '--state', 'open', '--draft', '--json', FIELDS, '--limit', String(limit)], options);
  if (!list.ok) return { available: false, error: list.error, drafts: [] };
  let prs;
  try {
    prs = JSON.parse(list.stdout || '[]');
  } catch {
    return { available: false, error: 'gh pr list returned output that is not JSON', drafts: [] };
  }
  const drafts = prs.map((pr) => {
    const compare = tryRun('gh', ['api', `repos/{owner}/{repo}/compare/main...${pr.headRefName}`, '--jq', '[.behind_by, .ahead_by] | @tsv'], options);
    const [behind, ahead] = compare.ok ? compare.stdout.split('\t').map(Number) : [null, null];
    return { ...pr, behindMain: behind, aheadOfMain: ahead, ...(compare.ok ? {} : { error: compare.error }) };
  });
  drafts.sort((a, b) => (b.behindMain ?? -1) - (a.behindMain ?? -1));
  return { available: true, drafts };
}

export const staleWorkTool = {
  definition: {
    name: 'stale_work',
    title: 'Draft PRs behind main',
    description:
      'List open draft PRs with how many commits each is behind and ahead of main, through `gh` with a timeout. ' +
      'Returns `available: false` with the error when gh is missing, offline or signed out.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  run: (_args, ctx) => staleWork({ root: ctx.root, env: ctx.env }),
};
