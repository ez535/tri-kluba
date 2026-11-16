// Собирает game-data.json из прототипа (корневой index.html): игроки, клубы, финальный пул.
// Прототип — источник правды по данным, пока база не переехала в отдельные файлы.
// Запуск: node app/data/build-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '../../index.html'), 'utf8');
const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const upto = js.indexOf('// ---------- статистика');
const D = new Function(js.slice(0, upto) + `
  return {CLUBS, PL, ALLPOOL, NATCONF, LEAGUES, TOPCLUBS:[...TOPCLUBS]};`)();

const out = {
  version: new Date().toISOString().slice(0, 10),
  clubs: D.CLUBS,                       // id -> [название, цвет1, цвет2]
  leagues: D.LEAGUES,                   // [{id, name, clubs[]}]
  topClubs: D.TOPCLUBS,
  natConf: D.NATCONF,                   // сборная -> конфедерация
  // [ru, en, сборная, "клубы через пробел", "варианты|написания", известность]
  players: D.PL.map(p => [p.ru, p.en, p.nat, p.clubs.join(' '), p.vars.join('|'), p.sl]),
  // финальный пул: индекс игрока + подсказки
  finalPool: D.ALLPOOL.map(x => ({
    pid: x.p.id, conf: x.conf, league: x.league, pos: x.pos, born: x.born,
    fam: x.fam, club: x.club, career: x.career || null,
    retired: !!x.retired, rare: !!x.rare, hard: !!x.hard,
  })),
};
const file = path.join(here, 'game-data.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`${file}: ${out.players.length} игроков, ${out.finalPool.length} в финальном пуле, ${(fs.statSync(file).size / 1e6).toFixed(2)} МБ`);
