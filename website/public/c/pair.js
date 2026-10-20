(() => {
  const offer = new URLSearchParams(location.hash.slice(1)).get('o');
  const show = selector => { document.querySelector(selector).hidden = false; };
  let host;
  try {
    const bytes = Uint8Array.from(atob(offer.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    host = JSON.parse(new TextDecoder().decode(bytes)).n;
  } catch {
    show('[data-missing]');
    return;
  }
  show('[data-ready]');
  if (typeof host === 'string' && host) document.querySelector('[data-host]').textContent = host;
  document.querySelector('[data-open]').href = `oxbit://c#o=${offer}`;
  const copy = document.querySelector('[data-copy]');
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; });
  });
})();
