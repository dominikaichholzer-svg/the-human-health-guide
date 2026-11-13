// pin-badges.js
//
// Die sechs Leadership-Pins als eigene Grafik im Look einer Anstecknadel:
// goldener Rand, farbiges Email, goldenes Motiv, Glanzlicht, Schatten.
// Benutzt vom Leader- und vom Admin-Dashboard:
//   PIN_BADGE('consistency_queen', 64)            -> SVG-Text
//   PIN_BADGE('consistency_queen', 28, { dim: true }) -> blass (noch nicht erreicht)
// Die Schlüssel entsprechen netlify/functions/_lib/pins.js.

(function () {
  // Email-Farbe je Pin: hell (Lichtpunkt) und dunkel (Rand)
  const ENAMEL = {
    team_builder:       ['#3FA27A', '#0E3B2C'],
    team_growth:        ['#4C7FD0', '#132A57'],
    plan_hero:          ['#D0505A', '#4A1218'],
    challenge_champion: ['#E2853A', '#5A2410'],
    consistency_queen:  ['#8E5BC9', '#2A1347'],
    contact_queen:      ['#2FA3A6', '#0B3A3D'],
  };

  // Motive, gezeichnet im Bereich 34..86 um die Mitte (60/60)
  const ICONS = {
    team_builder:
      // Stiel als Fläche (ein Verlauf auf einer exakt senkrechten Linie würde nicht gezeichnet)
      '<path d="M57.6 86 C57 76 57.4 66 59 54 L61.6 54 C62.4 66 62.8 76 62.4 86 Z" fill="url(#G)"/>' +
      '<path d="M40 87 C46 81 74 81 80 87 Z" fill="url(#G)"/>' +
      '<path d="M59 68 C47 68 38 61 36 48 C49 47 58 55 59 68 Z" fill="url(#G)"/>' +
      '<path d="M61 60 C62 46 72 37 86 36 C85 50 75 59 61 60 Z" fill="url(#G)"/>' +
      '<path d="M58 66 C52 63 46 58 41 51" fill="none" stroke="url(#E)" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>' +
      '<path d="M62 58 C69 54 76 47 82 40" fill="none" stroke="url(#E)" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>',
    team_growth:
      '<rect x="39" y="68" width="10" height="16" rx="2" fill="url(#G)"/>' +
      '<rect x="55" y="58" width="10" height="26" rx="2" fill="url(#G)"/>' +
      '<rect x="71" y="46" width="10" height="38" rx="2" fill="url(#G)"/>' +
      '<path d="M37 58 L52 46 L62 51 L79 36" fill="none" stroke="url(#G)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M71 35 L82 33 L80 44 Z" fill="url(#G)"/>',
    plan_hero:
      '<circle cx="58" cy="62" r="23" fill="none" stroke="url(#G)" stroke-width="4"/>' +
      '<circle cx="58" cy="62" r="14" fill="none" stroke="url(#G)" stroke-width="4"/>' +
      '<circle cx="58" cy="62" r="5.5" fill="url(#G)"/>' +
      '<path d="M58 62 L82 38" stroke="url(#G)" stroke-width="3.5" stroke-linecap="round"/>' +
      '<path d="M78 36 L86 34 L84 42 L81 39 Z" fill="url(#G)"/>',
    challenge_champion:
      '<path d="M60 33 C67 45 79 52 77 68 C76 80 68 87 60 87 C52 87 44 80 43 69 C42 60 48 53 52 47 C53 55 56 60 60 61 C58 52 56 44 60 33 Z" fill="url(#G)"/>' +
      '<path d="M60 63 C64 69 68 73 66 79 C65 83 62 85 60 85 C57 85 54 82 54 78 C54 73 58 70 60 63 Z" fill="url(#E)" opacity="0.85"/>',
    consistency_queen:
      '<path d="M38 76 L35 47 L48 59 L60 40 L72 59 L85 47 L82 76 Z" fill="url(#G)"/>' +
      '<rect x="37" y="77" width="46" height="7" rx="2" fill="url(#G)"/>' +
      '<circle cx="35" cy="45" r="3.5" fill="url(#G)"/><circle cx="60" cy="38" r="3.5" fill="url(#G)"/><circle cx="85" cy="45" r="3.5" fill="url(#G)"/>' +
      '<circle cx="60" cy="66" r="4" fill="url(#E)"/><circle cx="47" cy="68" r="2.6" fill="url(#E)"/><circle cx="73" cy="68" r="2.6" fill="url(#E)"/>',
    contact_queen:
      '<path d="M64 55 h14 a6 6 0 0 1 6 6 v10 a6 6 0 0 1 -6 6 h-2 v7 l-8 -7 h-4 a6 6 0 0 1 -6 -6 z" fill="none" stroke="url(#G)" stroke-width="3.5" stroke-linejoin="round"/>' +
      '<path d="M41 39 h28 a7 7 0 0 1 7 7 v15 a7 7 0 0 1 -7 7 h-16 l-9 8 v-8 h-3 a7 7 0 0 1 -7 -7 v-15 a7 7 0 0 1 7 -7 z" fill="url(#G)"/>' +
      '<circle cx="46" cy="53.5" r="3" fill="url(#E)"/><circle cx="55" cy="53.5" r="3" fill="url(#E)"/><circle cx="64" cy="53.5" r="3" fill="url(#E)"/>',
  };

  let uid = 0;
  window.PIN_BADGE = function (key, size, opts) {
    const o = opts || {};
    const [light, dark] = ENAMEL[key] || ['#B08A4A', '#3A2A12'];
    const icon = ICONS[key] || '<circle cx="60" cy="60" r="12" fill="url(#G)"/>';
    const id = 'pb' + (++uid); // eigene IDs je Grafik, damit mehrere auf einer Seite funktionieren
    const ic = icon.replace(/url\(#G\)/g, `url(#${id}g)`).replace(/url\(#E\)/g, `url(#${id}e)`);
    const s = size || 64;
    return `<svg class="pin-badge${o.dim ? ' dim' : ''}" width="${s}" height="${s}" viewBox="0 0 120 120" role="img" aria-hidden="true" style="display:inline-block; vertical-align:middle;${o.dim ? ' opacity:0.32; filter:grayscale(0.9);' : ''}">
      <defs>
        <linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#FFF3CC"/><stop offset="0.28" stop-color="#E8CB8F"/>
          <stop offset="0.6" stop-color="#C39A50"/><stop offset="1" stop-color="#7A5A24"/>
        </linearGradient>
        <linearGradient id="${id}b" x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#FFF3CC"/><stop offset="0.5" stop-color="#B8893F"/><stop offset="1" stop-color="#5E4318"/>
        </linearGradient>
        <radialGradient id="${id}e" cx="0.38" cy="0.32" r="0.8">
          <stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/>
        </radialGradient>
        <linearGradient id="${id}g" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stop-color="#FFF6D6"/><stop offset="0.45" stop-color="#EBCB86"/><stop offset="1" stop-color="#B0823A"/>
        </linearGradient>
        <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
        </linearGradient>
        <clipPath id="${id}c"><circle cx="60" cy="60" r="43"/></clipPath>
        <filter id="${id}f" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="3.5" stdDeviation="3.2" flood-color="#000" flood-opacity="0.5"/>
        </filter>
        <filter id="${id}i" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="0.8" flood-color="#000" flood-opacity="0.45"/>
        </filter>
      </defs>
      <g filter="url(#${id}f)">
        <circle cx="60" cy="60" r="53" fill="url(#${id}r)"/>
        <circle cx="60" cy="60" r="47" fill="url(#${id}b)"/>
        <circle cx="60" cy="60" r="43" fill="url(#${id}e)"/>
        <circle cx="60" cy="60" r="43" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="2"/>
        <g filter="url(#${id}i)">${ic}</g>
        <g clip-path="url(#${id}c)"><ellipse cx="52" cy="30" rx="44" ry="22" fill="url(#${id}s)" opacity="0.55"/></g>
        <circle cx="60" cy="60" r="52" fill="none" stroke="#FFF6D6" stroke-opacity="0.5" stroke-width="1"/>
      </g>
    </svg>`;
  };
})();
