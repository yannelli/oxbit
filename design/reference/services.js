// Mock service adapters. Each represents a real capability replaced in Phase 2 (see design/README.md).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function createServices(flags = {}) {
  const f = { fsFail: false, gitFail: false, searchFail: false, lspMode: 'ready', netDown: false, reconnectFails: false, ...flags };

  const fs = {
    // Real capability: workspace filesystem (local FS / remote agent)
    async create(path, isDir) { await wait(120); if (f.fsFail) throw new Error(`EACCES: permission denied, ${isDir ? 'mkdir' : 'open'} '${path}'`); return { path }; },
    async rename(from, to) { await wait(120); if (f.fsFail) throw new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`); return { from, to }; },
    async remove(path) { await wait(160); if (f.fsFail) throw new Error(`EACCES: permission denied, unlink '${path}'`); return { path }; },
    async write(path) { await wait(90); if (f.fsFail) throw new Error(`EROFS: read-only file system, write '${path}'`); return { path, savedAt: Date.now() }; },
  };

  const git = {
    // Real capability: git CLI / libgit2
    async stage() { await wait(80); },
    async unstage() { await wait(80); },
    async commit(message, count) { await wait(700); if (f.gitFail) throw new Error('pre-commit hook failed: eslint found 1 error'); return { sha: Math.random().toString(16).slice(2, 9), message, count }; },
    async push() { await wait(900); if (f.gitFail) throw new Error('fatal: unable to access origin: Could not resolve host: github.com'); },
    async checkout(branch) { await wait(300); return branch; },
  };

  const lsp = {
    // Real capability: language servers over LSP (tsserver, css-languageserver, eslint)
    async start(onState) { onState('starting'); await wait(1400); if (f.lspMode === 'failed') { onState('failed'); return; } if (f.lspMode === 'unavailable') { onState('unavailable'); return; } onState('ready'); },
    async restart(onState) { onState('restarting'); await wait(1200); onState(f.lspMode === 'failed' ? 'failed' : 'ready'); },
  };

  const search = {
    // Real capability: ripgrep over the workspace
    run(files, query, opts, onDone, onError, signal) {
      const t = setTimeout(() => {
        if (signal.cancelled) return;
        if (f.searchFail) { onError('Search worker crashed (ENOMEM). Try narrowing the include pattern.'); return; }
        onDone();
      }, 650);
      return () => clearTimeout(t);
    },
  };

  const ext = {
    // Real capability: extension host + marketplace API
    async install(e) { await wait(1100); if (e.failsInstall && !e._retried) { e._retried = true; throw new Error('Could not download package: network timeout after 30 s'); } },
    async toggle() { await wait(350); },
    async update() { await wait(900); },
    async uninstall() { await wait(500); },
  };

  const sync = {
    // Real capability: collaboration transport (WebSocket + CRDT)
    connect(onState) {
      onState('reconnecting');
      return setTimeout(() => onState(f.reconnectFails ? 'failed' : 'recovered'), 1800);
    },
  };

  const terminal = {
    // Real capability: PTY sessions (node-pty / remote agent)
    run(cmd, scripts, emit, done) {
      const script = scripts[cmd.trim()];
      if (cmd.trim() === '') { done(0); return () => {}; }
      if (!script) { setTimeout(() => { emit({ t: 'err', s: `zsh: command not found: ${cmd.split(' ')[0]}` }); done(127); }, 120); return () => {}; }
      let i = 0; let timer; let cancelled = false;
      const step = () => {
        if (cancelled) return;
        if (i >= script.length) { done(0); return; }
        const line = script[i++]; timer = setTimeout(() => { emit(line); step(); }, line.d);
      };
      step();
      return () => { cancelled = true; clearTimeout(timer); };
    },
  };

  return { flags: f, fs, git, lsp, search, ext, sync, terminal };
}
