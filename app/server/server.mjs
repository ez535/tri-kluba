// Сервер «Трёх клубов»: раздаёт веб-игру, держит комнаты по WebSocket, хранит итоги в SQLite.
// Без внешних зависимостей: нужен только Node 22.13+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../game/engine.mjs';
import { attach } from './ws.mjs';
import { openDb } from './db.mjs';
import { Room, DEFAULT_SETTINGS } from './room.mjs';
import { verifyInitData, startBot } from './telegram.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV = {
  port: +(process.env.PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),
  botToken: process.env.BOT_TOKEN || '',
  appShortName: process.env.APP_SHORT_NAME || '',
  dataDir: process.env.DATA_DIR || path.join(here, '../var'),
};
const log = (...a) => console.log(new Date().toISOString(), ...a);

const engine = createEngine(JSON.parse(fs.readFileSync(path.join(here, '../data/game-data.json'), 'utf8')));
const db = openDb(path.join(ENV.dataDir, 'game.sqlite'));
log(`База игроков: ${engine.PL.length}, финальный пул: ${engine.POOL.length}`);

// ---------- комнаты ----------
const rooms = new Map();               // code -> Room
const seasons = new Map();             // code -> таблица сезона
const sockets = new Map();             // uid -> Set<conn>
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => {
  for (;;) {
    const c = Array.from(crypto.randomBytes(5), b => ALPHA[b % ALPHA.length]).join('');
    if (!rooms.has(c) && !db.room(c)) return c;
  }
};
const season = code => { if (!seasons.has(code)) seasons.set(code, db.season(code)); return seasons.get(code); };

function makeRoom(code, hostUid, chatId, settings) {
  const room = new Room(code, {
    engine, hostUid, chatId, settings,
    onChange: broadcast,
    onFinished: (r, result) => {
      const winners = result.rows.filter(x => x.rank === 1).length;
      db.saveMatch(r.code, result, result.rows.map(x => ({ uid: x.uid, points: x.total, win: x.rank === 1 && winners < result.rows.length })));
      seasons.delete(r.code);
      db.saveRoom(r.code, r.settings, r.hostUid);
      if (r.chatId && bot) bot.send(r.chatId, resultsText(result)).catch(e => log('Telegram:', e.message));
    },
  });
  rooms.set(code, room);
  return room;
}
function getRoom(code) {
  if (rooms.has(code)) return rooms.get(code);
  const saved = db.room(code);
  if (!saved) return null;
  return makeRoom(code, saved.host_uid, saved.chat_id, JSON.parse(saved.settings || '{}'));
}
function broadcast(room) {
  const s = season(room.code);
  for (const m of room.members.values()) {
    if (!m.online) continue;
    const msg = JSON.stringify({ t: 'room', room: room.view(m.uid, s) });
    for (const c of sockets.get(m.uid) || []) if (c.code === room.code) c.sock.send(msg);
  }
}
function resultsText(res) {
  const medal = r => (r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}.`);
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return '<b>Итоги матча</b>\n' + res.rows.map(r => `${medal(r)} ${esc(r.name)} — ${r.total}`).join('\n') +
    `\n\nВ финале был загадан: <b>${esc(res.final.name)}</b>`;
}

// Комнаты, где давно никого нет, выгружаем из памяти (итоги и сезон остаются в базе).
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.onlineCount()) continue;
    const idle = now - r.emptySince;
    if (idle > (r.phase === 'round' || r.phase === 'final' ? 10 : 30) * 60000) { clearTimeout(r.timer); rooms.delete(code); seasons.delete(code); }
  }
}, 60000).unref();

// ---------- Telegram ----------
const bot = startBot({
  token: ENV.botToken, publicUrl: ENV.publicUrl, appShortName: ENV.appShortName, log,
  onGroupPlay: (chatId) => {
    const saved = db.roomByChat(chatId);
    if (saved) return saved.code;
    const code = newCode();
    db.addRoom(code, null, chatId, DEFAULT_SETTINGS);
    return code;
  },
});

// ---------- HTTP ----------
const WEB = path.join(here, '../web');
const TRAINING = path.join(here, '../../index.html');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
    res.end(body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
  if (url.pathname === '/health') return send(200, 'ok');
  // для автообновления: не перезапускаться, пока кто-то играет матч
  if (url.pathname === '/status') {
    const list = [...rooms.values()];
    return send(200, JSON.stringify({ rooms: list.length, matches: list.filter(r => r.phase === 'round' || r.phase === 'final').length,
      online: list.reduce((n, r) => n + r.onlineCount(), 0) }), 'application/json');
  }
  let file;
  if (url.pathname === '/training' || url.pathname === '/training/') file = TRAINING;
  else {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    file = path.join(WEB, rel);
    if (!file.startsWith(WEB + path.sep)) return send(404, 'Not found');
  }
  fs.readFile(file, (err, body) => {
    if (err) return send(404, 'Not found');
    const ext = path.extname(file);
    send(200, body, MIME[ext] || 'application/octet-stream',
      { 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  });
});

// ---------- WebSocket ----------
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const UID_RE = /^[a-z0-9]{16,40}$/;
const ws = attach(server, '/ws', sock => {
  const c = { sock, uid: null, name: '', code: null, tokens: 20, last: Date.now(), leaveTimer: null };
  ws.track(sock);
  const reply = (i, body) => sock.send(JSON.stringify({ t: 'res', i, ...body }));
  const room = () => (c.code ? rooms.get(c.code) : null);

  function enter(code, i) {
    const r = getRoom(code);
    if (!r) return reply(i, { error: 'Комната не найдена. Проверьте код.' });
    if (c.code && c.code !== code) rooms.get(c.code)?.leave(c.uid);
    c.code = code;
    const res = r.join(c.uid, c.name);
    if (res.error) { c.code = null; return reply(i, res); }
    reply(i, { ok: true, code });
  }

  sock.on('message', raw => {
    // не больше ~20 сообщений за несколько секунд с одного соединения
    const now = Date.now();
    c.tokens = Math.min(20, c.tokens + (now - c.last) / 250); c.last = now;
    if (c.tokens < 1) return; c.tokens--;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const i = m.i;
    try {
      if (m.t === 'hello') {
        let tg = null;
        if (m.initData) tg = verifyInitData(String(m.initData), ENV.botToken);
        if (tg) { c.uid = 'tg' + tg.id; c.name = db.user(c.uid)?.name || cleanName(tg.name); db.saveUser(c.uid, c.name, tg.id); }
        else {
          c.uid = UID_RE.test(m.uid) ? m.uid : crypto.randomBytes(12).toString('hex');
          c.name = db.user(c.uid)?.name || cleanName(m.name);
          if (c.name) db.saveUser(c.uid, c.name);
        }
        if (!sockets.has(c.uid)) sockets.set(c.uid, new Set());
        sockets.get(c.uid).add(c);
        sock.send(JSON.stringify({ t: 'hello', uid: c.uid, name: c.name, telegram: !!tg, startParam: tg?.startParam || null,
          bot: bot?.username || null, app: ENV.appShortName || null, publicUrl: ENV.publicUrl }));
        return;
      }
      if (!c.uid) return reply(i, { error: 'Нет соединения с профилем' });
      switch (m.t) {
        case 'name': {
          const n = cleanName(m.name);
          if (n.length < 2) return reply(i, { error: 'Имя — от 2 до 20 символов' });
          c.name = n; db.saveUser(c.uid, n);
          const r = room(); if (r?.members.has(c.uid)) { r.members.get(c.uid).name = n; r.changed(); }
          return reply(i, { ok: true, name: n });
        }
        case 'create': {
          if (!c.name) return reply(i, { error: 'Сначала представьтесь' });
          const code = newCode();
          db.addRoom(code, c.uid, null, DEFAULT_SETTINGS);
          makeRoom(code, c.uid, null, DEFAULT_SETTINGS);
          return enter(code, i);
        }
        case 'join': {
          if (!c.name) return reply(i, { error: 'Сначала представьтесь' });
          return enter(String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8), i);
        }
        case 'leave': { room()?.leave(c.uid); c.code = null; return reply(i, { ok: true }); }
        case 'report': {
          const text = String(m.text || '').trim().slice(0, 2000);
          if (!text) return reply(i, { error: 'Пустое сообщение' });
          db.addReport(c.uid, text, m.context || null);
          return reply(i, { ok: true });
        }
      }
      const r = room();
      if (!r) return reply(i, { error: 'Вы не в комнате' });
      const act = {
        settings: () => r.setSettings(c.uid, m.settings || {}),
        start: () => r.start(c.uid),
        answer: () => r.answer(c.uid, m.text),
        pick: () => r.pick(c.uid, +m.pid),
        skip: () => r.skip(c.uid),
        guess: () => r.guess(c.uid, m.text),
        gpick: () => r.guessPick(c.uid, +m.pid),
        pass: () => r.pass(c.uid),
        lobby: () => r.backToLobby(c.uid),
      }[m.t];
      if (!act) return reply(i, { error: 'Неизвестная команда' });
      reply(i, act() || { ok: true });
    } catch (e) {
      log('Ошибка обработки', m.t, e);
      reply(i, { error: 'Что-то пошло не так на сервере' });
    }
  });

  sock.on('close', () => {
    if (!c.uid) return;
    sockets.get(c.uid)?.delete(c);
    // Телефон мог просто свернуть приложение: даём несколько секунд вернуться.
    const code = c.code, uid = c.uid;
    if (!code) return;
    setTimeout(() => {
      const still = [...(sockets.get(uid) || [])].some(x => x.code === code);
      if (!still) rooms.get(code)?.setOnline(uid, false);
    }, 8000);
  });
});

server.listen(ENV.port, () => log(`Слушаю :${ENV.port}, адрес игры ${ENV.publicUrl}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('Останавливаюсь'); server.close(); process.exit(0); });
