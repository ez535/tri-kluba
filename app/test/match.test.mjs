// Сквозной тест: сервер + три игрока по WebSocket проходят матч целиком.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-'));

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, room: null, waiters: [], n: 0, pending: new Map() };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'room') { c.room = m.room; c.waiters = c.waiters.filter(w => !w(c.room)); }
    if (m.t === 'res' && c.pending.has(m.i)) { c.pending.get(m.i)(m); c.pending.delete(m.i); }
    if (m.t === 'hello') c.hello = m;
  };
  c.send = (t, body = {}) => new Promise(res => { const i = ++c.n; c.pending.set(i, res); ws.send(JSON.stringify({ t, i, ...body })); });
  c.until = pred => new Promise((res, rej) => {
    if (c.room && pred(c.room)) return res(c.room);
    const to = setTimeout(() => rej(new Error(`${name}: не дождался состояния`)), 20000);
    c.waiters.push(r => (pred(r) ? (clearTimeout(to), res(r), true) : false));
  });
  c.ready = new Promise(res => { ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', name })); res(); }; });
  return c;
}

test('матч вчетвером от лобби до итогов', { timeout: 60000 }, async () => {
  const srv = spawn(process.execPath, ['server/server.mjs'], {
    env: { ...process.env, PORT, DATA_DIR: dir, TEST_FAST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => String(d).includes('Слушаю') && r()));
  try {
    const [a, b, c, d] = ['Аня', 'Боря', 'Вика', 'Гоша'].map(client);
    await Promise.all([a, b, c, d].map(x => x.ready));
    const made = await a.send('create');
    assert.ok(made.ok, JSON.stringify(made));
    for (const x of [b, c, d]) assert.ok((await x.send('join', { code: made.code })).ok);
    await a.until(r => r.players.length === 4);
    assert.ok((await b.send('start')).error, 'начинать может только создатель');
    assert.ok((await a.send('start')).ok);

    for (let n = 1; n <= 5; n++) {
      const r = await a.until(x => x.phase === 'round' && x.round.n === n && !x.round.ended);
      // Аня отвечает опечаткой и выбирает вариант, Боря пропускает, остальные отвечают фамилией
      const ans = await a.send('answer', { text: 'Ибрагимовеч' });
      if (ans.kind === 'suggest') await a.send('pick', { pid: ans.options[0].pid }); else await a.send('skip');
      assert.ok((await b.send('skip')).ok);
      // Вика видит только «ответил», а не чужой ответ
      const seen = await c.until(x => x.status && x.status[b.hello.uid] === 'done');
      assert.equal(seen.round.mine, null);
      await c.send('answer', { text: 'Месси' });
      await d.send('answer', { text: 'Роналду' });
      await a.until(x => x.phase !== 'round' || x.round.ended);
      assert.equal(r.round.triple.length, 3);
    }
    const f = await a.until(x => x.phase === 'final');
    assert.equal(f.final.hints.length, 3);
    // все пасуют до последнего этапа
    for (let st = 1; st <= 5; st++) {
      await a.until(x => x.phase === 'final' && x.final.stage === st && !x.final.nextAt);
      for (const x of [a, b, c, d]) await x.send('pass');
    }
    const res = await a.until(x => x.phase === 'results');
    assert.equal(res.results.rows.length, 4);
    assert.equal(res.results.rounds.length, 5);
    assert.ok(res.results.final.name);
    assert.equal(res.season.length, 4, 'сезон комнаты записан');
    assert.ok((await a.send('lobby')).ok);
    await b.until(x => x.phase === 'lobby');
    for (const x of [a, b, c, d]) x.ws.close();
  } finally { srv.kill(); }
});
