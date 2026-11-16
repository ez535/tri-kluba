import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../game/engine.mjs';

const E = createEngine(JSON.parse(fs.readFileSync(new URL('../data/game-data.json', import.meta.url))));
const all = E.allowedFor(E.leagues.map(l => l.id));
const pid = name => E.PL.find(p => p.ru === name).id;

test('фамилия, опечатка и однофамильцы', () => {
  assert.equal(E.resolve('Аршавин').kind, 'ok');
  assert.equal(E.resolve('Ибрахимович').kind, 'ok');
  const s = E.resolve('Аршавн');
  assert.equal(s.kind, 'suggest');
  assert.ok(s.ids.includes(pid('Андрей Аршавин')));
  assert.equal(E.resolve('Сильва').kind, 'ambiguous');
  assert.equal(E.resolve('Давид Сильва').kind, 'ok');
  assert.equal(E.resolve('ыыыыыыы').kind, 'none');
});

test('очки: 5 / 6 за редкого / 3 за повтор', () => {
  const t = ['barca', 'ars', 'juve'];
  const used = new Set();
  const henry = E.scoreAnswer([pid('Тьерри Анри')], t, used);
  assert.equal(henry.pts, 5);
  used.add(henry.pid);
  assert.equal(E.scoreAnswer([pid('Тьерри Анри')], t, used).pts, 3);
  assert.equal(E.scoreAnswer([pid('Габриэль Хайнце')], ['psg', 'mu', 'real'], new Set()).pts, 6);
});

test('тройки: пять на матч, у каждой есть ответ', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const tr = E.pickTriples(level, all);
    assert.equal(tr.length, 5);
    for (const t of tr) assert.ok(E.fitInfo(t).count >= 1 || level === 'hard');
  }
});

test('финал: однозначный игрок, подсказки, очки', () => {
  for (let i = 0; i < 50; i++) {
    const f = E.pickFinal('medium', all);
    assert.ok(!f.hard);
    assert.equal(E.hints(f, 1).length, 3);
    assert.equal(E.hints(f, 5).length, 7);
    const c = E.candidates(f, 5, 'medium');
    assert.equal(c.known + c.rare, 1);
  }
  const f = E.POOL.find(x => x.p.ru === 'Тьерри Анри');
  assert.deepEqual(E.hints(f, 5).map(h => h.value).slice(-2), ['Барселона', 'Арсенал']);
  assert.equal(E.finalPoints(f, 1), f.rare ? 7 : 5);
});
