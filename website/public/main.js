(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const nav = document.querySelector('[data-nav]');
  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const revealed = document.querySelectorAll('[data-reveal]');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealed.forEach((el) => el.classList.add('is-visible'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    revealed.forEach((el) => io.observe(el));
  }

  document.querySelectorAll('[data-copy]').forEach((button) => {
    const root = button.closest('[data-copy-root]');
    const source = root && root.querySelector('[data-copy-text]');
    if (!source) return;
    const original = button.innerHTML;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
      } catch {
        return;
      }
      button.classList.add('is-done');
      button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
      button.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        button.classList.remove('is-done');
        button.innerHTML = original;
        button.setAttribute('aria-label', 'Copy');
      }, 1600);
    });
  });

  document.querySelectorAll('[data-spot]').forEach((card) => {
    card.addEventListener('pointermove', (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    });
  });

  const ua = navigator.userAgent;
  const platform = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios'
    : /Macintosh|Mac OS X/.test(ua) ? 'mac'
    : /Linux/.test(ua) && !/Android/.test(ua) ? 'linux'
    : undefined;
  document.querySelector(`.download[data-platform="${platform}"]`)?.classList.add('is-recommended');
  const primary = document.querySelector('[data-primary-download]');
  const labels = { mac: 'Download for macOS', linux: 'Download for Linux', ios: 'Get it on TestFlight' };
  if (primary && platform) {
    primary.textContent = labels[platform];
    if (platform === 'ios') primary.href = 'https://testflight.apple.com/join/P2WqdUYS';
  }

  // Release file names carry the version, so links resolve against the latest release.
  const assetPatterns = {
    mac: /_aarch64\.dmg$/,
    'linux-x64-appimage': /_amd64\.AppImage$/,
    'linux-x64-deb': /_amd64\.deb$/,
    'linux-arm64-appimage': /_aarch64\.AppImage$/,
    'linux-arm64-deb': /_arm64\.deb$/,
  };
  const applyRelease = (release) => {
    const assets = release.assets || [];
    document.querySelectorAll('[data-asset]').forEach((link) => {
      const asset = assets.find((item) => assetPatterns[link.dataset.asset]?.test(item.name));
      if (asset) link.href = asset.browser_download_url;
    });
    const mac = assets.find((item) => assetPatterns.mac.test(item.name));
    if (primary && platform === 'mac' && mac) primary.href = mac.browser_download_url;
    if (release.tag_name) {
      document.querySelectorAll('[data-release-tag]').forEach((el) => { el.textContent = release.tag_name; });
      document.querySelectorAll('[data-release-label]').forEach((el) => { el.textContent = `Every ${release.tag_name} file, with checksums`; });
    }
  };
  const releaseKey = 'oxbit-latest-release';
  const cached = (() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(releaseKey));
      return stored && Date.now() - stored.at < 10 * 60 * 1000 ? stored.release : undefined;
    } catch {
      return undefined;
    }
  })();
  if (cached) applyRelease(cached);
  else {
    fetch('https://api.github.com/repos/yannelli/oxbit/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((release) => {
        const slim = { tag_name: release.tag_name, assets: (release.assets || []).map(({ name, browser_download_url }) => ({ name, browser_download_url })) };
        try { sessionStorage.setItem(releaseKey, JSON.stringify({ at: Date.now(), release: slim })); } catch {}
        applyRelease(slim);
      })
      .catch(() => {});
  }

  const tilt = document.querySelector('[data-tilt]');
  if (tilt && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    const win = tilt.querySelector('.window');
    tilt.addEventListener('pointermove', (event) => {
      const rect = tilt.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      win.style.setProperty('--ry', `${x * 6}deg`);
      win.style.setProperty('--rx', `${-y * 6}deg`);
    });
    tilt.addEventListener('pointerleave', () => {
      win.style.setProperty('--ry', '0deg');
      win.style.setProperty('--rx', '0deg');
    });
  }

  const terminal = document.querySelector('[data-terminal] .term-body');
  if (terminal) {
    const lines = [
      { text: '$ ', cls: 'p', typed: 'oxbit ~/code/orbit-dash' },
      { text: 'Oxbit runtime starting', cls: 'd' },
      { text: 'workspace  orbit-dash' },
      { text: 'runtime    http://127.0.0.1:52814/#pair=…', cls: 'u' },
      { text: 'watching   1,248 files' },
      { text: 'opening the editor in your browser', cls: 'd' },
      { text: '' },
      { text: '$ ', cls: 'p', typed: 'oxbit --status' },
      { text: 'runtime for orbit-dash is serving on port 52814', cls: 'd' },
      { text: '' },
      { text: '$ ', cls: 'p', caret: true },
    ];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const span = (cls, text) => {
      const el = document.createElement('span');
      if (cls) el.className = cls;
      el.textContent = text;
      return el;
    };
    const play = async () => {
      terminal.replaceChildren();
      for (const line of lines) {
        terminal.append(span(line.cls, line.text));
        if (line.typed) {
          const target = span('', '');
          terminal.append(target);
          for (const ch of line.typed) {
            target.textContent += ch;
            await sleep(reduceMotion ? 0 : 40 + Math.random() * 50);
          }
          await sleep(reduceMotion ? 0 : 350);
        }
        if (line.caret) {
          terminal.append(span('caret', ''));
          break;
        }
        terminal.append('\n');
        await sleep(reduceMotion ? 0 : 140);
      }
    };
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      play();
    };
    if (!('IntersectionObserver' in window)) {
      start();
    } else {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          start();
          io.disconnect();
        }
      }, { threshold: 0.3 });
      io.observe(terminal);
    }
  }
})();
