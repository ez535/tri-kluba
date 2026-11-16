// Клиент «Трёх клубов»: комнаты для друзей. Работает в браузере и как Telegram Mini App.
// Всё решает сервер; здесь только отрисовка и ввод.

const $ = id => document.getElementById(id);
const app = $('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
const ptsWord = n => `${n} ${plural(n, 'очко', 'очка', 'очков')}`;
const store = {
  get: k => { try { return localStorage.getItem('tk-' + k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem('tk-' + k) : localStorage.setItem('tk-' + k, v); } catch { /* приватный режим */ } },
};
const LEVELS = { easy: 'Лёгкий', medium: 'Средний', hard: 'Тяжёлый' };
const MARK = { yes: '✓', no: '✗', near: '≈', older: '↑ старше', younger: '↓ моложе', early: '↓ раньше', late: '↑ позже', was: 'играл там', '?': 'нет данных' };

// ---------- Telegram ----------
const tgData = (() => {
  const h = new URLSearchParams(location.hash.slice(1));
  return h.get('tgWebAppData') || null;
})();
if (tgData) {
  const s = document.createElement('script');
  s.src = 'https://telegram.org/js/telegram-web-app.js';
  s.async = true;
  s.onload = () => { try { Telegram.WebApp.ready(); Telegram.WebApp.expand(); } catch { /* вне Telegram */ } };
  document.head.appendChild(s);
}

// ---------- состояние ----------
const S = {
  ws: null, ready: false, hello: null, uid: store.get('uid'), name: store.get('name') || '',
  room: null, offset: 0, n: 0, pending: new Map(), tries: 0,
  msg: '', msgKind: '', options: null, draft: '', draftKey: '', joinErr: '', busy: false,
  wantRoom: new URLSearchParams(location.search).get('room') || store.get('room'),
};
const now = () => Date.now() + S.offset;

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => { S.tries = 0; ws.send(JSON.stringify({ t: 'hello', uid: S.uid, name: S.name, initData: tgData })); };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'hello') onHello(m);
    else if (m.t === 'room') onRoom(m.room);
    else if (m.t === 'res' && S.pending.has(m.i)) { S.pending.get(m.i)(m); S.pending.delete(m.i); }
  };
  ws.onclose = () => {
    S.ready = false;
    for (const r of S.pending.values()) r({ error: 'Нет связи с сервером' });
    S.pending.clear();
    banner('Связь потеряна, переподключаемся…');
    setTimeout(connect, Math.min(8000, 500 * 2 ** S.tries++));
  };
}
function send(t, body = {}) {
  return new Promise(res => {
    if (!S.ready && t !== 'hello') return res({ error: 'Нет связи с сервером' });
    const i = ++S.n;
    S.pending.set(i, res);
    S.ws.send(JSON.stringify({ t, i, ...body }));
  });
}
function banner(text) { const b = $('banner'); b.hidden = !text; b.textContent = text || ''; }

async function onHello(m) {
  S.hello = m; S.uid = m.uid; S.ready = true;
  store.set('uid', m.uid);
  if (m.name) { S.name = m.name; store.set('name', m.name); }
  else if (S.name) { const r = await send('name', { name: S.name }); if (r.error) S.name = ''; }
  banner('');
  const code = m.startParam || S.wantRoom;
  if (code && S.name) await join(code, true);
  else render();
}
function onRoom(room) {
  const prev = S.room;
  S.offset = room.serverNow - Date.now();
  S.room = room;
  store.set('room', room.code);
  // новый раунд или этап — чистим ввод и подсказки
  const key = room.phase + (room.round ? room.round.n : '') + (room.final ? room.final.stage : '');
  if (key !== S.draftKey) { S.draftKey = key; S.draft = ''; S.msg = ''; S.options = null; }
  if (!prev || prev.phase !== room.phase) window.scrollTo(0, 0);
  render();
}
async function join(code, quiet) {
  const r = await send('join', { code });
  if (r.error) {
    S.wantRoom = null; store.set('room', null);
    if (!quiet) S.joinErr = r.error;
    render();
  }
  return r;
}

// ---------- отрисовка ----------
// Экран — список блоков. Обновляются только изменившиеся блоки: когда отвечает друг,
// меняются его отметка, а поле ввода остаётся на месте и клавиатура на телефоне не закрывается.
let shown = [];   // [[ключ, html]]
function paint(regs, after) {
  if (typeof regs === 'string') regs = [['main', regs]];
  regs = regs.filter(([, h]) => h);
  const sameLayout = regs.length === shown.length && regs.every(([k], i) => shown[i][0] === k);
  if (!sameLayout) {
    app.innerHTML = regs.map(([k, h]) => `<div data-r="${k}">${h}</div>`).join('');
  } else {
    const nodes = app.children;
    regs.forEach(([, h], i) => { if (h !== shown[i][1]) nodes[i].innerHTML = h; });
  }
  shown = regs;
  after?.();
  tick();
}
const repaint = () => { shown = []; render(); };
function render() {
  if (!S.hello) return paint('<p class="wait">Подключаемся к игре…</p>');
  if (!S.name) return renderName();
  const r = S.room;
  if (!r) return renderHome();
  const me = r.players.find(p => p.uid === r.me);
  if (me?.spectator && (r.phase === 'round' || r.phase === 'final')) return renderSpectator();
  ({ lobby: renderLobby, round: renderRound, final: renderFinal, results: renderResults })[r.phase]();
}

function hero() {
  const card = (n, c1, c2, i) => `<div class="card deal" style="--c1:${c1};--c2:${c2};--i:${i}"><div class="stripes"></div><div class="plate">${n}</div></div>`;
  return `<header class="hero"><div class="hand hero-hand">${card('Барселона', '#A50044', '#004D98', 0)}${card('Зенит', '#0089CF', '#FFFFFF', 1)}${card('Арсенал', '#EF0107', '#FFFFFF', 2)}</div>
    <h1>Три клуба</h1><p class="lead">Назовите футболиста, который играл за все три клуба. Играйте с друзьями — до восьми человек в комнате.</p></header>`;
}
function renderName() {
  paint(`${hero()}<section><h2>Как вас зовут?</h2><p class="sub">Это имя увидят друзья в комнате.</p>
    <form id="f" class="row"><label for="nm" class="sr">Имя</label><input id="nm" class="field" maxlength="20" autocomplete="nickname" placeholder="Имя" value="${esc(S.name)}">
    <button class="btn">Дальше</button></form><p class="err" id="err" aria-live="polite"></p></section>`, () => {
    $('f').onsubmit = async e => {
      e.preventDefault();
      const r = await send('name', { name: $('nm').value });
      if (r.error) { $('err').textContent = r.error; return; }
      S.name = r.name; store.set('name', r.name);
      if (S.wantRoom) await join(S.wantRoom, false); else render();
    };
    $('nm').focus();
  });
}
function renderHome() {
  paint(`${hero()}
    <p class="hello"><span>Вы играете как <b>${esc(S.name)}</b></span>${S.hello.telegram ? '' : '<button class="sup-link" id="rename">изменить</button>'}</p>
    <section class="stack" style="margin-top:18px">
      <button class="btn wide" id="create">Создать комнату</button>
      <p class="or">или войдите по коду от друзей</p>
      <form id="jf" class="row"><label for="code" class="sr">Код комнаты</label>
        <input id="code" class="field code" maxlength="8" autocomplete="off" autocapitalize="characters" placeholder="Код" value="">
        <button class="btn">Войти</button></form>
      <p class="err" aria-live="polite">${esc(S.joinErr)}</p>
    </section>
    <section><h2>Тренировка</h2><p class="sub">Разминка перед игрой с друзьями: один на один с ботом, три уровня сложности.</p>
      <a class="btn ghost wide" style="display:block;text-align:center;text-decoration:none" href="/training">Тренироваться с ботом</a></section>
    <button class="sup-off" disabled title="Скоро появится">Сообщить об ошибке · скоро</button>`, () => {
    $('create').onclick = async () => { S.joinErr = ''; const r = await send('create'); if (r.error) { S.joinErr = r.error; render(); } };
    $('jf').onsubmit = async e => { e.preventDefault(); const c = $('code').value.trim(); if (!c) return; S.joinErr = ''; await join(c, false); };
    $('rename') && ($('rename').onclick = () => { S.name = ''; render(); });
  });
}
function nav(title) {
  return `<nav class="nav"><button class="exit" id="exit">← Выйти</button><span>${esc(title)}</span></nav>`;
}
function bindExit(inMatch) {
  const b = $('exit'); if (!b) return;
  b.onclick = async () => {
    if (inMatch && !b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Выйти? Матч продолжится без вас'; b.classList.add('armed');
      setTimeout(() => { delete b.dataset.armed; b.textContent = '← Выйти'; b.classList.remove('armed'); }, 3000);
      return;
    }
    await send('leave'); S.room = null; S.wantRoom = null; store.set('room', null);
    history.replaceState(null, '', location.pathname); render();
  };
}
function inviteLink(code) {
  const h = S.hello;
  return h.bot && h.app ? `https://t.me/${h.bot}/${h.app}?startapp=${code}` : `${location.origin}/?room=${code}`;
}
function peopleList(r) {
  return `<ul class="people">${r.players.map(p => `<li class="${p.uid === r.me ? 'me' : ''}${p.online ? '' : ' off'}"><span class="dot"></span>${esc(p.name)}${p.uid === r.me ? ' (вы)' : ''}
    <span class="tag">${p.uid === r.hostUid ? 'создатель' : p.online ? '' : 'не в сети'}</span></li>`).join('')}</ul>`;
}
function seasonTable(r) {
  if (!r.season?.length) return '';
  const month = new Date().toLocaleString('ru-RU', { month: 'long' });
  return `<section><h2>Сезон комнаты · ${esc(month)}</h2><div class="tablewrap"><table class="season"><thead><tr><th>Игрок</th><th>Побед</th><th>Матчей</th><th>Очков</th><th>Лучший</th></tr></thead><tbody>
    ${r.season.map(s => `<tr><td>${esc(s.name || 'Игрок')}</td><td>${s.wins}</td><td>${s.games}</td><td>${s.points}</td><td>${s.best}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function renderLobby() {
  const r = S.room, host = r.hostUid === r.me, n = r.players.filter(p => p.online).length;
  const seg = (k, opts) => `<div class="seg" role="group">${opts.map(([v, t]) => `<button data-k="${k}" data-v="${v}" aria-pressed="${String(r.settings[k]) === String(v)}" ${host ? '' : 'disabled'}>${t}</button>`).join('')}</div>`;
  paint(`${nav('Комната')}
    <div class="roomcode"><div><small>Код комнаты</small><b>${esc(r.code)}</b></div><button class="btn" id="inv">Пригласить</button></div>
    <p class="msg soft" id="invmsg" aria-live="polite"></p>
    <h2>Игроки · ${n} из 8</h2>${peopleList(r)}
    <section><h2>Настройки</h2>
      <div class="setting"><span>Сложность</span>${seg('level', Object.entries(LEVELS))}</div>
      <div class="setting"><span>Время на ответ в раундах с клубами</span>${seg('answerTime', [[15, '15 с'], [30, '30 с'], [45, '45 с'], [60, '60 с']])}</div>
      <p class="sub">В финальном раунде — ${r.settings.finalTime} секунд на каждый этап.${host ? '' : ' Настройки меняет создатель комнаты.'}</p>
    </section>
    ${host ? `<button class="btn wide" id="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'Ждём хотя бы одного друга' : 'Начать матч'}</button>` : '<p class="wait">Ждём, пока создатель комнаты начнёт матч</p>'}
    <p class="err" id="err" aria-live="polite"></p>
    ${seasonTable(r)}`, () => {
    bindExit(false);
    $('inv').onclick = async () => {
      const url = inviteLink(r.code), text = `Сыграем в «Три клуба»? Комната ${r.code}`;
      try { if (navigator.share) { await navigator.share({ title: 'Три клуба', text, url }); return; } } catch { return; }
      try { await navigator.clipboard.writeText(`${text}: ${url}`); $('invmsg').textContent = 'Ссылка скопирована — отправьте её друзьям.'; }
      catch { $('invmsg').textContent = url; }
    };
    app.querySelectorAll('.seg button').forEach(b => b.onclick = () => send('settings', { settings: { [b.dataset.k]: b.dataset.v } }));
    $('start') && ($('start').onclick = async () => { const x = await send('start'); if (x.error) $('err').textContent = x.error; });
  });
}

// ---------- раунды ----------
function timerHTML() { return '<div class="timer"><div class="bar"><span id="bar"></span></div><b id="secs"></b></div>'; }
function statusChips(r, label) {
  return `<div class="chips">${r.players.filter(p => r.status && p.uid in r.status).map(p => `<span class="pchip ${r.status[p.uid] === 'done' ? 'done' : ''}${p.online ? '' : ' off'}" title="${r.status[p.uid] === 'done' ? label : 'думает'}"><i></i>${esc(p.uid === r.me ? 'Вы' : p.name)}</span>`).join('')}</div>`;
}
function suggestHTML() {
  if (!S.options) return esc(S.msg);
  return `Может быть, вы имели в виду: ${S.options.map(o => `<button class="fix" data-pid="${o.pid}">${esc(o.name)}</button>`).join('')}<button class="fix no">Нет</button>`;
}
// Поле ввода не зависит от черновика: его значение живёт в самом поле, пока блок не пересоздан.
function inputBlock(label, action) {
  return `<form id="af" class="answer"><label for="ans" class="sr">${label}</label>
    <input id="ans" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="send" placeholder="${label}">
    <button class="btn" id="go">${action}</button></form>`;
}
const msgBlock = extra => `<p class="msg" id="msg" aria-live="polite">${suggestHTML()}</p>${extra || ''}`;
function handleReply(x, pickType) {
  S.options = null;
  if (x.error) S.msg = x.error;
  else if (x.kind === 'suggest') { S.options = x.options; S.msg = ''; S.pickType = pickType; }
  else if (x.kind === 'ambiguous') S.msg = `Такая фамилия у ${x.count} игроков. Уточните имя, например «Давид Сильва».`;
  else if (x.kind === 'none') S.msg = 'Не нашли такого игрока. Проверьте написание: ответ ещё не засчитан.';
  else { S.msg = ''; S.draft = ''; }
  render();
  if (S.options || S.msg) $('ans')?.focus({ preventScroll: true });
}
function bindInput(sendType, pickType) {
  const i = $('ans');
  if (!i) return;
  if (!i.dataset.init) { i.dataset.init = '1'; i.value = S.draft; }
  i.oninput = () => { S.draft = i.value; };
  $('af').onsubmit = async e => {
    e.preventDefault();
    const text = i.value.trim(); if (!text || S.busy) return;
    S.busy = true; const x = await send(sendType, { text }); S.busy = false;
    handleReply(x, pickType);
  };
  app.querySelectorAll('.fix').forEach(b => b.onclick = async () => {
    if (b.classList.contains('no')) { S.options = null; S.msg = 'Исправьте ответ и отправьте ещё раз.'; render(); $('ans')?.focus(); return; }
    handleReply(await send(pickType, { pid: +b.dataset.pid }), pickType);
  });
}
function card(c, i) {
  return `<div class="card" style="--c1:${c.c1};--c2:${c.c2};--i:${i}"><div class="stripes"></div><div class="plate">${esc(c.name)}</div></div>`;
}
function renderRound() {
  const r = S.room, R = r.round, mine = R.mine;
  const result = mine ? (mine.skipped ? 'Вы пропустили раунд. 0 очков.'
    : `${esc(mine.name)}: ${mine.k} ${plural(mine.k, 'клуб', 'клуба', 'клубов')} из 3${mine.repeat && mine.k === 3 ? ', повтор' : ''}${mine.pts === 6 ? ', редкий ответ' : ''}. +${ptsWord(mine.pts)}.`) : '';
  const open = !mine && !R.ended;
  paint([
    ['nav', nav(`Комната ${r.code}`)],
    ['top', `<div class="top"><span>Раунд ${R.n} из ${R.total}</span><span>${LEVELS[r.settings.level]}</span><span>Ваши очки: <b>${R.myTotal}</b></span></div>${R.ended ? '' : timerHTML()}`],
    ['cards', `<div class="hand">${R.triple.map(card).join('')}</div>
      <p class="fitcount">Под эту тройку подходят ${R.fit >= 20 ? '20+ игроков' : `${R.fit} ${plural(R.fit, 'игрок', 'игрока', 'игроков')}`}</p>`],
    ['chips', statusChips(r, 'ответил')],
    ['input', open ? inputBlock('Фамилия игрока', 'Ответить') : ''],
    ['msg', open ? msgBlock('<button class="link" id="skip">Пропустить раунд</button>')
      : mine ? `<div class="mine">${result}<small>${R.ended ? 'Раунд завершён. Следующий через пару секунд…' : 'Ждём остальных. Чужие ответы откроются в конце матча.'}</small></div>`
        : '<div class="mine">Время вышло. 0 очков.<small>Следующий раунд через пару секунд…</small></div>'],
  ], () => {
    bindExit(true);
    bindInput('answer', 'pick');
    $('skip') && ($('skip').onclick = async () => handleReply(await send('skip')));
  });
}
function renderFinal() {
  const r = S.room, F = r.final, me = F.mine || {};
  const labels = ['Конфедерация', 'Лига', 'Амплуа', F.plate.retired ? 'Карьера' : 'Возраст', 'Национальность', 'Самый известный клуб', 'Клуб'];
  const rows = labels.map((l, i) => {
    const h = F.hints[i], st = i < 3 ? 1 : i - 1;
    return h ? `<li class="open${i === F.hints.length - 1 && F.stage > 1 ? ' fresh' : ''}"><span>${esc(h.label)}</span><b>${esc(h.value)}</b></li>` : `<li><span>${esc(l)}</span><b>Этап ${st}</b></li>`;
  }).join('');
  const total = F.cand.known + F.cand.rare;
  const tries = me.tries?.length ? `<div class="tries"><h3>Ваши попытки</h3><p class="count">Стрелки показывают, чем загаданный игрок отличается от названного. ≈ — та же линия: защита, полузащита или атака.</p>
    ${me.tries.map(t => `<div class="try"><b>${esc(t.name)}</b><div class="cmp">${t.cmp.map(([l, v]) => `<span class="m ${v === '?' ? 'na' : v}">${esc(l)}: ${MARK[v]}</span>`).join('')}</div></div>`).join('')}</div>` : '';
  const open = !me.done && !F.nextAt && !me.moved;
  let action;
  if (me.done) action = `<div class="mine">Верно, это ${esc(me.name)}! +${ptsWord(me.pts)}.<small>Ждём остальных — итоги откроются, когда финал закончится.</small></div>`;
  else if (F.nextAt) action = '<div class="mine">Открываем следующую подсказку…</div>';
  else if (me.moved) action = `<div class="mine">${me.passed ? 'Пропуск.' : 'Неверно.'} Следующая попытка — на следующем этапе.<small>Ждём остальных.</small></div>`;
  else action = msgBlock('<button class="link" id="pass">Не знаю, открыть следующую подсказку</button>');
  paint([
    ['nav', nav(`Комната ${r.code}`)],
    ['top', `<div class="top"><span>Финальный раунд, этап ${F.stage} из 5</span><span>На кону: <b>${ptsWord(F.stake)}</b></span></div>${F.nextAt ? '' : timerHTML()}`],
    ['hints', `<div class="tier ${F.plate.rare ? 'rare' : ''}">${F.plate.rare ? 'Загадан малоизвестный игрок: до 7 очков' : 'Загадан известный игрок: до 5 очков'}. ${F.plate.retired ? 'Завершил карьеру' : 'Играет сейчас'}</div>
      <ul class="hints">${rows}</ul>
      <p class="count">Под эти подсказки ${plural(total, 'подходит', 'подходят', 'подходят')}: ${F.cand.known} ${plural(F.cand.known, 'известный', 'известных', 'известных')}, ${F.cand.rare} ${plural(F.cand.rare, 'малоизвестный', 'малоизвестных', 'малоизвестных')}</p>`],
    ['chips', statusChips(r, 'сделал ход')],
    ['input', open ? inputBlock('Фамилия игрока', 'Угадать') : ''],
    ['msg', action],
    ['tries', tries],
  ], () => {
    bindExit(true);
    bindInput('guess', 'gpick');
    $('pass') && ($('pass').onclick = async () => handleReply(await send('pass')));
  });
}
function renderSpectator() {
  const r = S.room;
  paint(`${nav(`Комната ${r.code}`)}<div class="mine">Матч уже идёт. Вы сыграете в следующем.<small>${r.phase === 'round' ? `Раунд ${r.round.n} из ${r.round.total}` : `Финальный раунд, этап ${r.final.stage}`}</small></div>
    ${statusChips(r, 'сделал ход')}<h2>Игроки</h2>${peopleList(r)}`, () => bindExit(false));
}
function renderResults() {
  const r = S.room, R = r.results, host = r.hostUid === r.me;
  const mine = R.rows.find(x => x.uid === r.me);
  const head = !mine ? 'Матч завершён' : mine.rank === 1 ? (R.rows.filter(x => x.rank === 1).length > 1 ? 'Ничья за первое место' : 'Победа!') : `${mine.rank}-е место`;
  paint(`${nav(`Комната ${r.code}`)}
    <header class="score"><p>${head}</p></header>
    <table class="rtab">${R.rows.map(x => `<tr><td class="n">${x.rank}</td><td>${esc(x.name)}${x.uid === r.me ? ' (вы)' : ''}<br><small class="sub">финал: ${x.finalStage ? `этап ${x.finalStage}, +${x.finalPts}` : 'не угадал'}</small></td><td class="t">${x.total}</td></tr>`).join('')}</table>
    <div class="actions">${host ? '<button class="btn wide" id="again">Ещё матч</button><button class="btn ghost wide" id="lobby">В лобби</button>' : '<p class="wait">Ждём, пока создатель начнёт следующий матч</p>'}</div>
    <p class="err" id="err" aria-live="polite"></p>
    <h2>Ответы по раундам</h2>
    ${R.rounds.map((x, i) => `<div class="rnd"><h3>${i + 1}. ${x.triple.map(esc).join(' · ')}</h3>
      ${R.rows.map(p => { const a = x.answers[p.uid]; return `<div class="ans"><span>${esc(p.name)}: ${a.name ? esc(a.name) : '—'}${a.repeat ? ' (повтор)' : ''}</span><b class="p${a.pts}">${a.pts}</b></div>`; }).join('')}
      <p class="ex">Подходили: ${x.fit.length ? x.fit.map(esc).join(', ') : '—'}</p></div>`).join('')}
    <div class="rnd"><h3>Финал: загадан ${esc(R.final.name)}</h3>
      ${R.rows.map(p => `<div class="ans"><span>${esc(p.name)}</span><b>${p.finalStage ? `этап ${p.finalStage} · +${p.finalPts}` : 'не угадал'}</b></div>`).join('')}</div>
    ${seasonTable(r)}`, () => {
    bindExit(false);
    $('again') && ($('again').onclick = async () => { const x = await send('start'); if (x.error) $('err').textContent = x.error; });
    $('lobby') && ($('lobby').onclick = () => send('lobby'));
  });
}

// ---------- таймер ----------
function tick() {
  const r = S.room, bar = $('bar'), secs = $('secs');
  if (!r || !bar) return;
  const dl = r.phase === 'round' ? r.round.deadline : r.phase === 'final' ? r.final.deadline : 0;
  const total = (r.phase === 'round' ? r.settings.answerTime : r.settings.finalTime) * 1000;
  const left = Math.max(0, dl - now());
  bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
  secs.textContent = Math.ceil(left / 1000);
  bar.parentElement.classList.toggle('low', left < 5000);
}
setInterval(tick, 200);

connect();
