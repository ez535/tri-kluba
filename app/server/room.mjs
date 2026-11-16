// Комната для друзей: лобби → 5 раундов с клубами → финальный раунд → итоги.
// Сервер — единственный судья: ответы проверяются здесь, чужие ответы скрыты до итогов.
import { norm } from '../game/engine.mjs';

export const MAX_PLAYERS = 8;
const FAST = process.env.TEST_FAST ? 0.05 : 1;   // в автотестах паузы короче
const PAUSE_AFTER_ROUND = 3500 * FAST;   // показать свой результат перед следующим раундом
const PAUSE_AFTER_STAGE = 1200 * FAST;
const LEVELS = ['easy', 'medium', 'hard'];
const ANSWER_TIMES = [15, 30, 45, 60];
export const DEFAULT_SETTINGS = { level: 'medium', answerTime: 30, finalTime: 45 };

export class Room {
  constructor(code, { engine, hostUid, chatId = null, settings = {}, onChange, onFinished }) {
    this.code = code;
    this.E = engine;
    this.hostUid = hostUid;
    this.chatId = chatId;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.members = new Map();        // uid -> {uid, name, online, spectator}
    this.phase = 'lobby';
    this.match = null;
    this.results = null;
    this.timer = null;
    this.onChange = onChange || (() => {});
    this.onFinished = onFinished || (() => {});
    this.emptySince = Date.now();
  }

  // ---------- участники ----------
  join(uid, name) {
    let m = this.members.get(uid);
    if (!m) {
      const seats = [...this.members.values()].filter(x => !x.spectator).length;
      const midMatch = this.phase === 'round' || this.phase === 'final';
      if (!midMatch && seats >= MAX_PLAYERS) return { error: 'В комнате уже 8 игроков' };
      m = { uid, name, online: true, spectator: midMatch };
      this.members.set(uid, m);
    }
    m.name = name;
    m.online = true;
    if (!this.members.get(this.hostUid)?.online) this.hostUid = uid;
    this.changed();
    return { ok: true };
  }
  setOnline(uid, online) {
    const m = this.members.get(uid);
    if (!m) return;
    m.online = online;
    if (!online && uid === this.hostUid) this.#passHost();
    if (online && !this.members.get(this.hostUid)?.online) this.hostUid = uid;
    if (!this.onlineCount()) this.emptySince = Date.now();
    this.#checkProgress();
    this.changed();
  }
  leave(uid) {
    if (!this.members.has(uid)) return;
    if (this.phase === 'lobby' || this.phase === 'results' || this.members.get(uid).spectator) this.members.delete(uid);
    else this.members.get(uid).online = false;
    if (uid === this.hostUid) this.#passHost();
    if (!this.onlineCount()) this.emptySince = Date.now();
    this.#checkProgress();
    this.changed();
  }
  #passHost() {
    const next = [...this.members.values()].find(m => m.online && !m.spectator) || [...this.members.values()].find(m => m.online);
    if (next) this.hostUid = next.uid;
  }
  onlineCount() { return [...this.members.values()].filter(m => m.online).length; }
  changed() { this.onChange(this); }

  setSettings(uid, s) {
    if (uid !== this.hostUid || (this.phase !== 'lobby' && this.phase !== 'results')) return { error: 'Настройки меняет создатель комнаты в лобби' };
    if (LEVELS.includes(s.level)) this.settings.level = s.level;
    if (ANSWER_TIMES.includes(+s.answerTime)) this.settings.answerTime = +s.answerTime;
    this.changed();
    return { ok: true };
  }

  // ---------- матч ----------
  start(uid) {
    if (uid !== this.hostUid) return { error: 'Начать матч может только создатель комнаты' };
    if (this.phase !== 'lobby' && this.phase !== 'results') return { error: 'Матч уже идёт' };
    for (const m of this.members.values()) m.spectator = !m.online;
    for (const [id, m] of this.members) if (!m.online) this.members.delete(id);
    const players = [...this.members.keys()];
    if (players.length < 2) return { error: 'Нужно хотя бы двое игроков' };
    const allowed = this.E.allowedFor(this.E.leagues.map(l => l.id));
    this.match = {
      players,
      level: this.settings.level,
      allowed,
      triples: this.E.pickTriples(this.settings.level, allowed),
      rounds: [],
      used: new Map(players.map(p => [p, new Set()])),
      pending: new Map(),            // uid -> pid[], варианты «может быть, вы имели в виду»
      final: null,
    };
    this.results = null;
    this.#startRound(0);
    return { ok: true };
  }
  #inMatch(uid) { return this.match?.players.includes(uid); }
  #active() { return this.match.players.filter(u => this.members.get(u)?.online); }
  #schedule(ms, fn) { clearTimeout(this.timer); this.timer = setTimeout(fn, Math.max(0, ms)); }

  #startRound(i) {
    this.phase = 'round';
    const r = { n: i + 1, triple: this.match.triples[i], deadline: Date.now() + this.settings.answerTime * 1000,
      answers: new Map(), ended: false, nextAt: null };
    this.match.rounds[i] = r;
    this.match.pending.clear();
    this.#schedule(r.deadline - Date.now(), () => this.#endRound());
    this.changed();
  }
  #round() { return this.match.rounds[this.match.rounds.length - 1]; }

  answer(uid, text) {
    const r = this.#canAnswer(uid);
    if (r.error) return r;
    const res = this.E.resolve(String(text).slice(0, 80));
    if (res.kind === 'ok') return this.#record(uid, res.ids);
    if (res.kind === 'ambiguous') return { kind: 'ambiguous', count: res.count };
    if (res.kind === 'suggest') {
      this.match.pending.set(uid, res.ids);
      return { kind: 'suggest', options: res.ids.map(pid => ({ pid, name: this.E.player(pid).ru })) };
    }
    return { kind: 'none' };
  }
  pick(uid, pid) {
    const r = this.#canAnswer(uid);
    if (r.error) return r;
    if (!this.match.pending.get(uid)?.includes(pid)) return { error: 'Этого варианта не было в списке' };
    return this.#record(uid, [pid]);
  }
  skip(uid) {
    const r = this.#canAnswer(uid);
    if (r.error) return r;
    this.#round().answers.set(uid, { skipped: true, pts: 0, k: 0 });
    this.#afterAnswer();
    return { ok: true };
  }
  #canAnswer(uid) {
    if (this.phase !== 'round' || !this.#inMatch(uid)) return { error: 'Сейчас не время отвечать' };
    const r = this.#round();
    if (r.ended || r.answers.has(uid)) return { error: 'Ответ в этом раунде уже принят' };
    return r;
  }
  #record(uid, ids) {
    const r = this.#round(), used = this.match.used.get(uid);
    const s = this.E.scoreAnswer(ids, r.triple, used);
    used.add(s.pid);
    r.answers.set(uid, { pid: s.pid, pts: s.pts, k: s.k, repeat: s.repeat });
    this.match.pending.delete(uid);
    this.#afterAnswer();
    return { ok: true };
  }
  #afterAnswer() {
    const r = this.#round();
    if (this.#active().every(u => r.answers.has(u))) this.#endRound();
    else this.changed();
  }
  #endRound() {
    const r = this.#round();
    if (r.ended) return;
    r.ended = true;
    r.nextAt = Date.now() + PAUSE_AFTER_ROUND;
    const next = this.match.rounds.length;
    this.#schedule(PAUSE_AFTER_ROUND, () => (next < this.match.triples.length ? this.#startRound(next) : this.#startFinal()));
    this.changed();
  }

  // ---------- финальный раунд ----------
  #startFinal() {
    this.phase = 'final';
    const f = this.E.pickFinal(this.match.level, this.match.allowed, true);
    this.match.final = { f, stage: 0, deadline: 0, nextAt: null,
      players: new Map(this.match.players.map(u => [u, { done: false, stage: 0, moved: false, tries: [], passed: false }])) };
    this.match.pending.clear();
    this.#nextStage();
  }
  #nextStage() {
    const F = this.match.final;
    F.stage++;
    F.nextAt = null;
    for (const p of F.players.values()) { p.moved = p.done; p.passed = false; }
    F.deadline = Date.now() + this.settings.finalTime * 1000;
    this.#schedule(F.deadline - Date.now(), () => this.#endStage());
    this.changed();
  }
  #endStage() {
    const F = this.match.final;
    if (F.nextAt) return;
    const allDone = this.match.players.every(u => F.players.get(u).done);
    if (F.stage >= 5 || allDone) return this.#finish();
    F.nextAt = Date.now() + PAUSE_AFTER_STAGE;
    this.#schedule(PAUSE_AFTER_STAGE, () => this.#nextStage());
    this.changed();
  }
  #canGuess(uid) {
    if (this.phase !== 'final' || !this.#inMatch(uid)) return { error: 'Сейчас не время угадывать' };
    const F = this.match.final, p = F.players.get(uid);
    if (F.nextAt || p.done || p.moved) return { error: 'Попытка на этом этапе уже использована' };
    return p;
  }
  guess(uid, text) {
    const p = this.#canGuess(uid);
    if (p.error) return p;
    const F = this.match.final, raw = String(text).slice(0, 80);
    if (F.f.p.vars.includes(norm(raw))) return this.#commitGuess(uid, F.f.pid);
    const res = this.E.resolve(raw);
    if (res.kind === 'ok') return this.#commitGuess(uid, res.ids[0]);
    if (res.kind === 'ambiguous') return { kind: 'ambiguous', count: res.count };
    if (res.kind === 'suggest') {
      this.match.pending.set(uid, res.ids);
      return { kind: 'suggest', options: res.ids.map(pid => ({ pid, name: this.E.player(pid).ru })) };
    }
    return { kind: 'none' };
  }
  guessPick(uid, pid) {
    const p = this.#canGuess(uid);
    if (p.error) return p;
    if (!this.match.pending.get(uid)?.includes(pid)) return { error: 'Этого варианта не было в списке' };
    return this.#commitGuess(uid, pid);
  }
  pass(uid) {
    const p = this.#canGuess(uid);
    if (p.error) return p;
    p.moved = true; p.passed = true;
    this.#afterMove();
    return { ok: true };
  }
  #commitGuess(uid, pid) {
    const F = this.match.final, p = F.players.get(uid);
    this.match.pending.delete(uid);
    p.moved = true;
    if (pid === F.f.pid) { p.done = true; p.stage = F.stage; }
    else p.tries.push({ name: this.E.player(pid).ru, cmp: this.E.compare(pid, F.f) });
    this.#afterMove();
    return { ok: true, correct: p.done };
  }
  #afterMove() {
    const F = this.match.final;
    if (this.#active().every(u => F.players.get(u).moved)) this.#endStage();
    else this.changed();
  }
  // Кто-то ушёл со связи — не ждём его, если остальные уже ответили.
  #checkProgress() {
    if (!this.match || !this.#active().length) return;
    if (this.phase === 'round' && !this.#round().ended) {
      const r = this.#round();
      if (this.#active().every(u => r.answers.has(u))) this.#endRound();
    } else if (this.phase === 'final' && !this.match.final.nextAt) {
      const F = this.match.final;
      if (this.#active().every(u => F.players.get(u).moved)) this.#endStage();
    }
  }

  // ---------- итоги ----------
  #finish() {
    clearTimeout(this.timer);
    const M = this.match, F = M.final, E = this.E;
    const rows = M.players.map(uid => {
      const roundPts = M.rounds.map(r => r.answers.get(uid)?.pts || 0);
      const fp = F.players.get(uid);
      const finalPts = E.finalPoints(F.f, fp.done ? fp.stage : 0);
      const top = roundPts.filter(x => x >= 5).length;
      return { uid, name: this.members.get(uid)?.name || 'Игрок', roundPts, finalStage: fp.done ? fp.stage : 0,
        finalPts, total: roundPts.reduce((a, b) => a + b, 0) + finalPts, top };
    });
    const better = (a, b) => b.total - a.total || b.top - a.top || b.finalPts - a.finalPts;
    rows.sort(better);
    rows.forEach((r, i) => { r.rank = i && better(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1; });
    const result = {
      finished: Date.now(),
      level: M.level,
      rows,
      rounds: M.rounds.map(r => ({
        triple: r.triple.map(c => E.clubName(c)),
        fit: E.fitInfo(r.triple).top,
        answers: Object.fromEntries(M.players.map(uid => {
          const a = r.answers.get(uid);
          return [uid, a ? { name: a.skipped ? null : E.player(a.pid).ru, pts: a.pts, repeat: !!a.repeat } : { name: null, pts: 0 }];
        })),
      })),
      final: { name: F.f.p.ru, rare: F.f.rare, retired: F.f.retired, hints: E.hints(F.f, 5) },
    };
    this.results = result;
    this.phase = 'results';
    this.match = null;
    for (const m of this.members.values()) m.spectator = false;
    for (const [id, m] of this.members) if (!m.online) this.members.delete(id);
    this.onFinished(this, result);
    this.changed();
  }
  backToLobby(uid) {
    if (uid !== this.hostUid || this.phase !== 'results') return { error: 'Вернуться в лобби может создатель комнаты' };
    this.phase = 'lobby';
    this.changed();
    return { ok: true };
  }

  // ---------- что видит конкретный игрок ----------
  view(uid, season = []) {
    const E = this.E, M = this.match, now = Date.now();
    const v = {
      code: this.code, phase: this.phase, me: uid, hostUid: this.hostUid, settings: this.settings,
      serverNow: now, season, chat: !!this.chatId,
      players: [...this.members.values()].map(m => ({ uid: m.uid, name: m.name, online: m.online, spectator: m.spectator })),
    };
    if (this.phase === 'round') {
      const r = M.rounds[M.rounds.length - 1], a = r.answers.get(uid);
      v.round = {
        n: r.n, total: M.triples.length, deadline: r.deadline, ended: r.ended, nextAt: r.nextAt,
        triple: r.triple.map(c => ({ id: c, name: E.clubName(c), c1: E.CLUBS[c][1], c2: E.CLUBS[c][2] })),
        fit: E.fitInfo(r.triple).count,
        mine: a ? { skipped: !!a.skipped, name: a.skipped ? null : E.player(a.pid).ru, pts: a.pts, k: a.k, repeat: !!a.repeat } : null,
        myTotal: M.rounds.reduce((s, x) => s + (x.answers.get(uid)?.pts || 0), 0),
      };
      v.status = Object.fromEntries(M.players.map(u => [u, r.answers.has(u) ? 'done' : 'thinking']));
    }
    if (this.phase === 'final') {
      const F = M.final, p = F.players.get(uid);
      v.final = {
        stage: F.stage, deadline: F.deadline, nextAt: F.nextAt,
        plate: { rare: F.f.rare, retired: F.f.retired, max: E.finalPoints(F.f, 1) },
        stake: E.finalPoints(F.f, F.stage),
        hints: E.hints(F.f, F.stage),
        cand: E.candidates(F.f, F.stage, M.level),
        mine: p ? { done: p.done, stage: p.stage, moved: p.moved, passed: p.passed, tries: p.tries,
          pts: p.done ? E.finalPoints(F.f, p.stage) : 0, name: p.done ? F.f.p.ru : null } : null,
      };
      v.status = Object.fromEntries(M.players.map(u => [u, F.players.get(u).moved ? 'done' : 'thinking']));
    }
    if (this.phase === 'results') v.results = this.results;
    return v;
  }
}
