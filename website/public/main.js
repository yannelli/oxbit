(() => {
  document.documentElement.classList.add('js');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const nav = document.querySelector('[data-nav]');
  const onScroll = () => nav?.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const menu = document.querySelector('.mobile-menu');
  menu?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary').focus();
  });
  menu?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => { menu.open = false; });
  });

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

  const heroButtons = document.querySelector('[data-hero-buttons]');
  if (heroButtons) {
    const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
      || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const primary = heroButtons.querySelector(`[data-hero-action="${isAppleMobile ? 'ios' : 'install'}"]`);
    if (primary) {
      heroButtons.querySelectorAll('.btn').forEach((link) => {
        link.classList.toggle('btn-primary', link === primary);
        link.classList.toggle('btn-ghost', link !== primary);
      });
      heroButtons.prepend(primary);
      heroButtons.classList.add('is-ranked');
    }
  }

  document.querySelectorAll('[data-copy]').forEach((button) => {
    const root = button.closest('[data-copy-root]');
    const source = root && root.querySelector('[data-copy-text]');
    if (!source) return;
    const original = button.innerHTML;
    const originalLabel = button.getAttribute('aria-label');
    const status = document.createElement('span');
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    root.append(status);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
      } catch {
        status.textContent = 'Copy failed. Select and copy the command text.';
        return;
      }
      status.textContent = 'Command copied.';
      button.classList.add('is-done');
      button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
      button.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        button.classList.remove('is-done');
        button.innerHTML = original;
        if (originalLabel) button.setAttribute('aria-label', originalLabel);
        else button.removeAttribute('aria-label');
        status.textContent = '';
      }, 1600);
    });
  });

  const localLinks = new Map([...document.querySelectorAll('.local-nav a[href^="#"]')].map((link) => [link.hash.slice(1), link]));
  if (localLinks.size && 'IntersectionObserver' in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        localLinks.forEach((link) => link.removeAttribute('aria-current'));
        localLinks.get(entry.target.id)?.setAttribute('aria-current', 'location');
      }
    }, { rootMargin: '-35% 0px -60% 0px' });
    localLinks.forEach((_, id) => {
      const section = document.getElementById(id);
      if (section) sectionObserver.observe(section);
    });
  }

  document.querySelectorAll('[data-spot]').forEach((card) => {
    card.addEventListener('pointermove', (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    });
  });

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
      { text: '/Users/dev/code/orbit-dash', cls: 'd' },
      { text: 'http://127.0.0.1:52817/#pair=3f9a1c07be42', cls: 'u' },
      { text: '' },
      { text: '$ ', cls: 'p', typed: 'oxbit --status' },
      { text: 'Workspace: /Users/dev/code/orbit-dash' },
      { text: 'Runtime: http://127.0.0.1:52817' },
      { text: 'Process: 48213', cls: 'd' },
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
