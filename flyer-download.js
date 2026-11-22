// Knopf "Bild herunterladen" für die Flyer-Seiten (neujahr-flyer, advent-flyer, advent-post).
// Die Links bleiben gleich: der Knopf erscheint unter dem Flyer und speichert ihn in Originalgröße als PNG.
// Am Handy öffnet sich das Teilen-Menü ("Bild sichern"), am Computer startet ein normaler Download.
(function(){
  const q = new URLSearchParams(location.search);
  if (q.get('export') === '1') return; // Export-Ansicht bleibt unverändert

  const css = document.createElement('style');
  css.textContent = `
    .dl-bar{ display:flex; flex-direction:column; align-items:center; gap:8px; padding:6px 16px 28px; font-family:Inter,system-ui,sans-serif; }
    .dl-btn{ appearance:none; border:none; cursor:pointer; background:#E8C26A; color:#1A1406; font:700 17px Inter,system-ui,sans-serif; padding:15px 28px; border-radius:14px; box-shadow:0 8px 22px rgba(0,0,0,.35); }
    .dl-btn[disabled]{ opacity:.6; cursor:wait; }
    .dl-hint{ color:#C9D8CD; font-size:13px; text-align:center; max-width:420px; line-height:1.45; }
    @media print{ .dl-bar{ display:none !important; } }`;
  document.head.appendChild(css);

  function target(){ return document.getElementById('flyer') || document.getElementById('post'); }

  function fileName(){
    const slug = (q.get('p') || 'flyer').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const page = location.pathname.replace(/^.*\//, '').replace(/\.html$/, '') || 'flyer';
    const v = q.get('v') === 'link' ? '-link' : '';
    const f = q.get('format') === 'a5' ? '-a5' : '';
    return `${page}${v}${f}-${slug}.png`;
  }

  async function render(){
    const el = target();
    const w = el.offsetWidth, h = el.offsetHeight; // Originalgröße (die Verkleinerung ist nur ein transform)
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    return window.htmlToImage.toBlob(el, {
      width: w, height: h, pixelRatio: 1, cacheBust: true,
      style: { transform: 'none', transformOrigin: 'top left', margin: '0' },
    });
  }

  async function save(btn){
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = 'Bild wird erstellt …';
    try {
      const blob = await render();
      const name = fileName();
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      alert('Das Bild konnte gerade nicht erstellt werden. Bitte versuch es nochmal oder mach einen Screenshot.');
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  }

  function addButton(){
    const stage = document.querySelector('.stage');
    if (!stage || !target() || document.querySelector('.dl-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'dl-bar';
    bar.innerHTML = '<button type="button" class="dl-btn">⬇️ Bild herunterladen</button><div class="dl-hint">Speichert den Flyer in voller Größe. Am Handy auf „Bild sichern“ tippen, dann kannst du ihn in Status oder Story posten.</div>';
    stage.after(bar);
    bar.querySelector('button').addEventListener('click', e => save(e.currentTarget));
  }

  // Erst wenn der Flyer fertig ist (Name und QR-Code geladen)
  (function wait(n){
    if (document.body.dataset.ready === '1') return addButton();
    if (n > 100) return addButton();
    setTimeout(() => wait(n + 1), 100);
  })(0);
})();
