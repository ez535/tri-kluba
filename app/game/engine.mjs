// Игровой движок «Трёх клубов»: поиск ответа, очки, тройки клубов, финальный раунд.
// Общий для сервера и (при необходимости) клиента. Правила — docs: правила v1.4.

export const ROUNDS = 5;
export const KNOWN = 60;     // известный игрок: 60+ языковых статей в Википедии
export const VISIBLE = 30;   // узнаваемый: 30+; меньше — «глубокий запас»
export const STAR = 85;      // звезда для лёгких троек

export const REGION = {
  'УЕФА': 'Европа', 'КОНМЕБОЛ': 'Южная Америка', 'КАФ': 'Африка', 'АФК': 'Азия',
  'КОНКАКАФ': 'Северная и Центральная Америка', 'ОФК': 'Океания',
};

export function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/([a-z])[̀-ͯ]+/g, '$1').normalize('NFC')
    .replace(/ё/g, 'е').replace(/['’`.]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}
export const plural = (n, a, b, c) => {
  const m = n % 10, h = n % 100;
  return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c;
};
export const ptsWord = n => n + ' ' + plural(n, 'очко', 'очка', 'очков');
export function age(born, now = new Date()) {
  const d = new Date(born);
  let a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a;
}
const rnd = a => a[Math.floor(Math.random() * a.length)];
export const shuffle = a => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// Оптимальное расстояние выравнивания строк (опечатки + перестановка соседних букв), с отсечкой.
function osa(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = 1e9;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

export function createEngine(data) {
  const CLUBS = data.clubs;
  const PL = data.players.map(([ru, en, nat, clubs, vars, sl], id) =>
    ({ id, ru, en, nat, clubs: clubs.split(' '), vars: vars.split('|'), sl }));
  const IDX = new Map();
  for (const p of PL) for (const v of p.vars) { if (!IDX.has(v)) IDX.set(v, []); IDX.get(v).push(p.id); }
  const POOL = data.finalPool.map(x => ({ ...x, p: PL[x.pid] }));
  const BYPID = new Map(POOL.map(x => [x.pid, x]));
  const TOP = new Set(data.topClubs);
  const clubName = c => (CLUBS[c] ? CLUBS[c][0] : c);
  const isRare = p => p.sl < KNOWN;

  // ---------- ответы ----------
  const fitCount = (p, t) => t.filter(c => p.clubs.includes(c)).length;
  const fitsAll = t => PL.filter(p => fitCount(p, t) === 3);
  function points(p, t, used) {
    const k = fitCount(p, t);
    let s = k === 3 ? 5 : k === 2 ? 3 : k === 1 ? 1 : 0;
    if (used.has(p.id)) s = Math.min(s, 3); else if (k === 3 && isRare(p)) s = 6;
    return { pts: s, k, repeat: used.has(p.id) };
  }
  function closest(n) {
    if (n.length < 3) return [];
    const max = n.length <= 4 ? 1 : n.length <= 7 ? 2 : 3;
    let best = max + 1, ids = new Set();
    for (const [v, list] of IDX) {
      const d = osa(n, v, max);
      if (d < best) { best = d; ids = new Set(list); } else if (d === best) list.forEach(i => ids.add(i));
    }
    return best <= max ? [...ids].slice(0, 3) : [];
  }
  // Что ввёл человек: точное совпадение, нужно уточнить имя, похожие варианты или ничего.
  function resolve(raw) {
    const n = norm(raw);
    if (!n) return { kind: 'none' };
    const ids = IDX.get(n);
    if (ids) {
      const exact = ids.some(id => norm(PL[id].ru) === n || norm(PL[id].en) === n);
      if (ids.length > 3 && !exact) return { kind: 'ambiguous', count: ids.length };
      return { kind: 'ok', ids };
    }
    const s = closest(n);
    return s.length ? { kind: 'suggest', ids: s } : { kind: 'none' };
  }
  // Из нескольких однофамильцев засчитывается лучший результат.
  function scoreAnswer(ids, triple, used) {
    let best = null;
    for (const id of ids) {
      const r = points(PL[id], triple, used);
      if (!best || r.pts > best.pts) best = { ...r, pid: id };
    }
    return best;
  }

  // ---------- тройки ----------
  const TCACHE = new Map();
  function allTriples(allowed) {
    const ck = [...allowed].sort().join();
    if (TCACHE.has(ck)) return TCACHE.get(ck);
    const m = new Map();
    for (const p of PL) {
      if (p.sl < VISIBLE) continue;
      const c = p.clubs.filter(x => allowed.has(x));
      for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) for (let k = j + 1; k < c.length; k++) {
        const t = [c[i], c[j], c[k]], key = [...t].sort().join();
        if (!m.has(key)) m.set(key, t);
      }
    }
    const r = [...m.values()];
    TCACHE.set(ck, r);
    return r;
  }
  function pickTriples(level, allowed, rounds = ROUNDS) {
    const stats = t => {
      const f = fitsAll(t);
      return { v: f.filter(p => p.sl >= VISIBLE).length, k: f.filter(p => p.sl >= KNOWN).length,
        star: f.some(p => p.sl >= STAR), best: f.reduce((b, p) => (p.sl > (b ? b.sl : 0) ? p : b), null) };
    };
    const top = new Set([...allowed].filter(c => TOP.has(c)));
    const stages = level === 'easy'
      ? [[top, x => x.star && x.v >= 3], [top, x => x.star], [allowed, x => x.star], [allowed, x => x.k >= 2], [allowed, x => x.k >= 1 && x.v >= 2], [allowed, () => true]]
      : level === 'medium'
        ? [[allowed, x => x.k >= 2 && x.v >= 3], [allowed, x => x.k >= 1], [allowed, () => true]]
        : [[allowed, x => x.k === 0 || x.v <= 2], [allowed, () => true]];
    const out = [], keys = new Set(), anchors = new Set();
    for (const strict of [true, false]) {
      for (const [set, pred] of stages) {
        if (out.length >= rounds) break;
        if (set.size < 3) continue;
        for (const t of shuffle(allTriples(set))) {
          if (out.length >= rounds) break;
          const key = [...t].sort().join();
          if (keys.has(key)) continue;
          const x = stats(t);
          if (!pred(x)) continue;
          if (strict && x.best && anchors.has(x.best.id)) continue;
          keys.add(key); if (x.best) anchors.add(x.best.id); out.push(shuffle(t));
        }
      }
      if (out.length >= rounds) break;
    }
    let i = 0;
    while (out.length && out.length < rounds) out.push(out[i++]);
    return out;
  }
  const fitInfo = t => {
    const f = fitsAll(t).filter(p => p.sl >= VISIBLE).sort((a, b) => b.sl - a.sl);
    return { count: f.length, top: f.slice(0, 3).map(p => p.ru) };
  };
  const allowedFor = leagueIds => new Set(data.leagues.filter(l => leagueIds.includes(l.id)).flatMap(l => l.clubs));

  // ---------- финальный раунд ----------
  const HINTS = [
    ['Конфедерация', f => `${f.conf} (${REGION[f.conf] || ''})`],
    ['Лига', f => f.league],
    ['Амплуа', f => f.pos],
    [f => (f.retired ? 'Карьера' : 'Возраст'), f => (f.retired ? f.career : `${age(f.born)} ${plural(age(f.born), 'год', 'года', 'лет')}`)],
    ['Национальность', f => f.p.nat],
    ['Самый известный клуб', f => clubName(f.fam)],
    ['Клуб', f => clubName(f.club)],
  ];
  const shown = stage => 2 + stage;                       // этап 1 = 3 подсказки
  const finalPoints = (f, stage) => (stage ? (f.rare ? 8 : 6) - stage : 0);
  const hintValues = f => HINTS.map(([, fn]) => String(fn(f)));
  const hints = (f, stage) => HINTS.slice(0, shown(stage)).map(([l, fn]) => ({ label: typeof l === 'function' ? l(f) : l, value: String(fn(f)) }));
  const poolFor = level => POOL.filter(x => level === 'hard' || !x.hard);
  function candidates(f, stage, level) {
    const n = shown(stage), want = hintValues(f).slice(0, n);
    let known = 0, rare = 0;
    for (const x of poolFor(level)) {
      if (x.retired !== f.retired) continue;
      const v = hintValues(x);
      if (want.every((w, i) => v[i] === w)) x.rare ? rare++ : known++;
    }
    return { known, rare };
  }
  // Загадываем только того, кого семь подсказок определяют однозначно.
  function pickFinal(level, allowed, everyone = false) {
    const pool = poolFor(level);
    const sig = new Map();
    for (const x of pool) { const s = x.retired + '|' + hintValues(x).join('|'); sig.set(s, (sig.get(s) || 0) + 1); }
    const unique = x => sig.get(x.retired + '|' + hintValues(x).join('|')) === 1;
    const ok = x => unique(x) && (everyone || x.p.clubs.some(c => allowed.has(c)) || allowed.has(x.club));
    let cand = pool.filter(ok);
    if (!cand.length) cand = pool.filter(unique);
    const rare = cand.filter(x => x.rare), act = cand.filter(x => !x.rare && !x.retired), ret = cand.filter(x => !x.rare && x.retired);
    if (rare.length && Math.random() < 0.25) return rnd(rare);
    if (act.length && (!ret.length || Math.random() < 0.5)) return rnd(act);
    return rnd(ret.length ? ret : cand);
  }
  const LINE = pos => (/Вратарь/.test(pos) ? 'gk' : /защитник/.test(pos) ? 'df' : /полузащитник/.test(pos) ? 'mf' : 'fw');
  function compare(pid, h) {
    const g = BYPID.get(pid) || { p: PL[pid] }, pg = g.p, out = [];
    out.push(['Конф.', (g.conf || data.natConf[pg.nat]) === h.conf ? 'yes' : 'no']);
    out.push(['Лига', g.league ? (g.league === h.league ? 'yes' : 'no') : '?']);
    out.push(['Амплуа', g.pos ? (g.pos === h.pos ? 'yes' : LINE(g.pos) === LINE(h.pos) ? 'near' : 'no') : '?']);
    out.push(['Нац.', pg.nat === h.p.nat ? 'yes' : 'no']);
    if (g.born && g.retired === h.retired) {
      if (h.retired) { const a = +g.career.slice(0, 4), b = +h.career.slice(0, 4); out.push(['Карьера', a === b ? 'yes' : b < a ? 'early' : 'late']); }
      else { const a = age(g.born), b = age(h.born); out.push(['Возраст', a === b ? 'yes' : b > a ? 'older' : 'younger']); }
    } else out.push([h.retired ? 'Карьера' : 'Возраст', '?']);
    out.push(['Изв. клуб', g.fam != null && g.fam === h.fam ? 'yes' : pg.clubs.includes(h.fam) ? 'was' : 'no']);
    out.push(['Клуб', g.club ? (g.club === h.club ? 'yes' : 'no') : pg.clubs.includes(h.club) ? 'was' : '?']);
    return out;
  }

  return {
    PL, POOL, CLUBS, clubName, leagues: data.leagues, allowedFor,
    resolve, scoreAnswer, pickTriples, fitInfo,
    pickFinal, hints, candidates, finalPoints, compare, isRare,
    player: id => PL[id],
  };
}
