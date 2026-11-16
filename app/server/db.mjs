// Хранилище: один файл SQLite (встроенный в Node). Резервная копия — это копия файла.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS users (
      uid TEXT PRIMARY KEY, name TEXT NOT NULL, tg_id INTEGER, created INTEGER NOT NULL, seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY, host_uid TEXT, chat_id INTEGER, settings TEXT, created INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS rooms_chat ON rooms(chat_id) WHERE chat_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, finished INTEGER NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS room_scores (
      room TEXT NOT NULL, uid TEXT NOT NULL, month TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room, uid, month));
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, created INTEGER NOT NULL, text TEXT NOT NULL, context TEXT);
  `);
  const q = {
    upsertUser: db.prepare(`INSERT INTO users(uid, name, tg_id, created, seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET name = excluded.name, tg_id = COALESCE(excluded.tg_id, users.tg_id), seen = excluded.seen`),
    getUser: db.prepare('SELECT * FROM users WHERE uid = ?'),
    getRoom: db.prepare('SELECT * FROM rooms WHERE code = ?'),
    roomByChat: db.prepare('SELECT * FROM rooms WHERE chat_id = ?'),
    addRoom: db.prepare('INSERT INTO rooms(code, host_uid, chat_id, settings, created) VALUES (?, ?, ?, ?, ?)'),
    saveSettings: db.prepare('UPDATE rooms SET settings = ?, host_uid = ? WHERE code = ?'),
    addMatch: db.prepare('INSERT INTO matches(room, finished, result) VALUES (?, ?, ?)'),
    addScore: db.prepare(`INSERT INTO room_scores(room, uid, month, points, games, wins, best) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(room, uid, month) DO UPDATE SET points = points + excluded.points, games = games + 1,
        wins = wins + excluded.wins, best = MAX(best, excluded.best)`),
    season: db.prepare(`SELECT s.uid, u.name, s.points, s.games, s.wins, s.best FROM room_scores s
      LEFT JOIN users u ON u.uid = s.uid WHERE s.room = ? AND s.month = ? ORDER BY s.wins DESC, s.points DESC LIMIT 20`),
    addReport: db.prepare('INSERT INTO reports(uid, created, text, context) VALUES (?, ?, ?, ?)'),
  };
  return {
    raw: db,
    saveUser: (uid, name, tgId = null) => { const now = Date.now(); q.upsertUser.run(uid, name, tgId, now, now); },
    user: uid => q.getUser.get(uid),
    room: code => q.getRoom.get(code),
    roomByChat: chatId => q.roomByChat.get(chatId),
    addRoom: (code, host, chatId, settings) => q.addRoom.run(code, host, chatId, JSON.stringify(settings), Date.now()),
    saveRoom: (code, settings, host) => q.saveSettings.run(JSON.stringify(settings), host, code),
    saveMatch(code, result, rows) {
      const month = new Date().toISOString().slice(0, 7);
      db.exec('BEGIN');
      try {
        q.addMatch.run(code, Date.now(), JSON.stringify(result));
        for (const r of rows) q.addScore.run(code, r.uid, month, r.points, r.win ? 1 : 0, r.points);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    season: code => q.season.all(code, new Date().toISOString().slice(0, 7)),
    addReport: (uid, text, context) => q.addReport.run(uid, Date.now(), text, JSON.stringify(context)),
  };
}
