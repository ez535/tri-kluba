// Telegram: проверка входа из Mini App и бот для групповых чатов.
// Игра работает и без Telegram — всё здесь включается, только если задан BOT_TOKEN.
import crypto from 'node:crypto';

// Проверка подписи initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
export function verifyInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = +params.get('auth_date');
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user?.id) return null;
  return { id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || 'Игрок',
    startParam: params.get('start_param') || null };
}

export function startBot({ token, publicUrl, appShortName, onGroupPlay, log = console.log }) {
  if (!token) return null;
  const api = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(65000),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result;
  };
  const bot = { username: null, send: (chatId, text, extra = {}) => api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra }) };
  const roomLink = code => (bot.username && appShortName
    ? `https://t.me/${bot.username}/${appShortName}?startapp=${code}`
    : `${publicUrl}/?room=${code}`);
  bot.roomLink = roomLink;

  async function handle(msg) {
    const text = msg.text || '';
    const m = text.match(/^\/(\w+)(?:@(\w+))?(?:\s+(.*))?$/);
    if (!m) return;
    const [, cmd, to, arg] = m;
    if (to && bot.username && to.toLowerCase() !== bot.username.toLowerCase()) return;
    const chat = msg.chat;
    if (chat.type === 'private') {
      if (cmd === 'start' || cmd === 'play') {
        const code = (arg || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        await bot.send(chat.id, code
          ? `Вас позвали в комнату <b>${code}</b>. Жмите кнопку, чтобы войти.`
          : 'Назовите футболиста, который играл за все три клуба. Играйте с друзьями или тренируйтесь с ботом.\n\nДобавьте меня в групповой чат и напишите /play — я создам комнату для всей компании.', {
          reply_markup: { inline_keyboard: [[{ text: code ? 'Войти в комнату' : 'Играть', web_app: { url: code ? `${publicUrl}/?room=${code}` : publicUrl } }]] },
        });
      }
      return;
    }
    if (cmd === 'play' || cmd === 'start') {
      const code = onGroupPlay(chat.id, chat.title || '');
      await bot.send(chat.id, `Комната этого чата: <b>${code}</b>. Заходите все, кто хочет сыграть, — матч начнёт тот, кто зашёл первым.\nИтоги матча я пришлю сюда.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: roomLink(code) }]] },
      });
    }
  }

  (async () => {
    try {
      const me = await api('getMe');
      bot.username = me.username;
      await api('setMyCommands', { commands: [{ command: 'play', description: 'Комната для игры' }] });
      log(`Telegram: бот @${me.username} запущен`);
    } catch (e) { log(`Telegram: не удалось запустить бота: ${e.message}`); return; }
    let offset = 0;
    for (;;) {
      try {
        const ups = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of ups) { offset = u.update_id + 1; if (u.message) await handle(u.message).catch(e => log(`Telegram: ${e.message}`)); }
      } catch (e) { log(`Telegram: ${e.message}`); await new Promise(r => setTimeout(r, 5000)); }
    }
  })();
  return bot;
}
