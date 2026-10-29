import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEDGERS = {
  'follow-ups': { file: 'follow-ups.md', prefix: 'F', home: 'repo', title: 'Follow-ups' },
  'open-questions': { file: 'open-questions.md', prefix: 'Q', home: 'local', title: 'Open questions' },
  'device-checks': { file: 'device-checks.md', prefix: 'D', home: 'repo', title: 'Device checks' },
  'account-actions': { file: 'account-actions.md', prefix: 'A', home: 'local', title: 'Account actions' },
  'flaky-tests': { file: 'flaky-tests.md', prefix: 'T', home: 'repo', title: 'Flaky tests' },
};
export const STATUSES = ['open', 'blocked', 'done', 'dropped'];
export const MAX_LINES = 300;

const HEADER = '| ID | Status | Item | Source | Updated |';
const ROW = /^\|\s*([A-Z]-\d+)\s*\|\s*(\w+)\s*\|\s*((?:\\.|[^|\\])*?)\s*\|\s*((?:\\.|[^|\\])*?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*$/;

export const ledgerDir = ({ root, env }) => env?.OXBIT_LEDGER_DIR || path.join(root, 'docs', 'agents', 'ledgers');
export const localLedgerDir = ({ env }) =>
  env?.OXBIT_LOCAL_LEDGER_DIR || path.join(env?.HOME ?? os.homedir(), '.agents', 'shared', 'oxbit-ledgers');
export const ledgerDirs = (ctx) => ({ repo: ledgerDir(ctx), local: localLedgerDir(ctx) });

const asDirs = (dirs) => (typeof dirs === 'string' ? { repo: dirs } : dirs);

const today = () => new Date().toISOString().slice(0, 10);

function ledgerInfo(name) {
  const info = LEDGERS[name];
  if (!info) throw new Error(`Unknown ledger "${name}". Use one of: ${Object.keys(LEDGERS).join(', ')}`);
  return info;
}

function checkStatus(status) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status "${status}". Use one of: ${STATUSES.join(', ')}`);
}

function cell(value) {
  return String(value).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

const uncell = (value) => value.replace(/\\\|/g, '|');

export function parseLedger(source) {
  const rows = [];
  for (const line of source.split('\n')) {
    const match = ROW.exec(line);
    if (match) rows.push({ id: match[1], status: match[2], item: uncell(match[3]), source: uncell(match[4]), updated: match[5] });
  }
  return rows;
}

function formatRow(row) {
  return `| ${row.id} | ${row.status} | ${cell(row.item)} | ${cell(row.source)} | ${row.updated} |`;
}

function locationFor(name, local) {
  if (local === undefined) return ledgerInfo(name).home;
  return local ? 'local' : 'repo';
}

function template(name, date) {
  return `# ${ledgerInfo(name).title} ledger\n\nCreated: ${date}. Last updated: ${date}.\n\n${HEADER}\n| --- | --- | --- | --- | --- |\n`;
}

function read(dirs, name, location, { create = false, date = today() } = {}) {
  const dir = asDirs(dirs)[location];
  if (!dir) throw new Error(`No ${location} ledger directory`);
  const file = path.join(dir, ledgerInfo(name).file);
  if (!existsSync(file)) {
    if (!create) return { file, source: '' };
    mkdirSync(dir, { recursive: true });
    return { file, source: template(name, date) };
  }
  return { file, source: readFileSync(file, 'utf8') };
}

function write(file, source, date) {
  const next = source.replace(/Last updated: \d{4}-\d{2}-\d{2}\./, `Last updated: ${date}.`);
  if (next.split('\n').length > MAX_LINES) {
    throw new Error(`${path.basename(file)} would pass ${MAX_LINES} lines. Move done and dropped rows to an archive file first.`);
  }
  writeFileSync(file, next);
}

export function listLedgers(dirs, { ledger, status } = {}) {
  if (status !== undefined) checkStatus(status);
  const names = ledger === undefined ? Object.keys(LEDGERS) : [ledger];
  const locations = Object.keys(asDirs(dirs));
  return names.map((name) => {
    const rows = locations.flatMap((location) =>
      parseLedger(read(dirs, name, location).source).map((row) => ({ ...row, location })),
    );
    return { ledger: name, rows: status === undefined ? rows : rows.filter((row) => row.status === status) };
  });
}

export function addEntry(dirs, { ledger, item, source, status = 'open', local, date = today() }) {
  if (typeof item !== 'string' || !item.trim()) throw new Error('item is required');
  if (typeof source !== 'string' || !source.trim()) throw new Error('source is required (PR, commit, run id or file:line)');
  checkStatus(status);
  const { prefix } = ledgerInfo(ledger);
  const location = locationFor(ledger, local);
  const { file, source: text } = read(dirs, ledger, location, { create: true, date });
  const rows = parseLedger(text);
  const next = Math.max(0, ...rows.map((row) => Number(row.id.slice(2)))) + 1;
  const row = { id: `${prefix}-${String(next).padStart(3, '0')}`, status, item, source, updated: date };
  const lines = text.replace(/\n+$/, '').split('\n');
  if (!lines.includes(HEADER)) throw new Error(`${path.basename(file)} has no "${HEADER}" table`);
  const last = lines.reduce((at, line, index) => (ROW.test(line) || line.startsWith('| ---') ? index : at), lines.indexOf(HEADER));
  lines.splice(last + 1, 0, formatRow(row));
  write(file, `${lines.join('\n')}\n`, date);
  return { ledger, location, row };
}

export function updateEntry(dirs, { ledger, id, status, item, source, local, date = today() }) {
  if (status !== undefined) checkStatus(status);
  const location = locationFor(ledger, local);
  const { file, source: text } = read(dirs, ledger, location);
  let updated = null;
  const lines = text.split('\n').map((line) => {
    const match = ROW.exec(line);
    if (!match || match[1] !== id) return line;
    const [row] = parseLedger(line);
    updated = { ...row, status: status ?? row.status, item: item ?? row.item, source: source ?? row.source, updated: date };
    return formatRow(updated);
  });
  if (!updated) throw new Error(`No row ${id} in the ${location} ${ledger} ledger`);
  write(file, lines.join('\n'), date);
  return { ledger, location, row: updated };
}

const ledgerSchema = { type: 'string', enum: Object.keys(LEDGERS) };
const statusSchema = { type: 'string', enum: STATUSES };
const localSchema = {
  type: 'boolean',
  description: 'true for the local ledger outside the repo, false for docs/agents/ledgers; defaults to the ledger home',
};

export const ledgerTools = [
  {
    definition: {
      name: 'ledger_list',
      title: 'List ledger rows',
      description:
        'List rows of the agent ledgers: follow-ups, device-checks and flaky-tests in docs/agents/ledgers, open-questions and account-actions ' +
        'in the local ledger (~/.agents/shared/oxbit-ledgers or OXBIT_LOCAL_LEDGER_DIR). Rows from both places are merged with their location. ' +
        'Run it at session start for open questions and before a release for device checks and account actions.',
      inputSchema: { type: 'object', properties: { ledger: ledgerSchema, status: statusSchema }, additionalProperties: false },
    },
    run: (args, ctx) => ({ ledgers: listLedgers(ledgerDirs(ctx), args) }),
  },
  {
    definition: {
      name: 'ledger_add',
      title: 'Add a ledger row',
      description:
        'Add a row with the next ID. Log parked work, unanswered questions, device checks, account actions, and each test flake with its run id. ' +
        'The repo is public: put personal, account and user-question rows in the local ledger, and leave secrets, key IDs and key paths out of both.',
      inputSchema: {
        type: 'object',
        properties: {
          ledger: ledgerSchema,
          item: { type: 'string', description: 'What is open, in one line' },
          source: { type: 'string', description: 'PR, commit, CI run id or file:line' },
          status: statusSchema,
          local: localSchema,
        },
        required: ['ledger', 'item', 'source'],
        additionalProperties: false,
      },
    },
    run: (args, ctx) => addEntry(ledgerDirs(ctx), { ...args, date: ctx.today?.() }),
  },
  {
    definition: {
      name: 'ledger_update',
      title: 'Update a ledger row',
      description: 'Change the status, item or source of a ledger row by ID, for example F-003 to done.',
      inputSchema: {
        type: 'object',
        properties: {
          ledger: ledgerSchema,
          id: { type: 'string', pattern: '^[A-Z]-\\d+$' },
          status: statusSchema,
          item: { type: 'string' },
          source: { type: 'string' },
          local: localSchema,
        },
        required: ['ledger', 'id'],
        additionalProperties: false,
      },
    },
    run: (args, ctx) => updateEntry(ledgerDirs(ctx), { ...args, date: ctx.today?.() }),
  },
];
