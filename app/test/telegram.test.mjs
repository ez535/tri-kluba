import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyInitData } from '../server/telegram.mjs';

// Собираем initData так же, как это делает Telegram, и проверяем, что подпись принимается, а подделка — нет.
function sign(fields, token) {
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
const token = '123456:TEST';
const user = JSON.stringify({ id: 42, first_name: 'Андрей', last_name: 'А.' });

test('правильная подпись принимается', () => {
  const r = verifyInitData(sign({ auth_date: String(Math.floor(Date.now() / 1000)), user, start_param: 'ABCDE' }, token), token);
  assert.deepEqual(r, { id: 42, name: 'Андрей А.', startParam: 'ABCDE' });
});
test('чужой токен, подмена данных и старая подпись отклоняются', () => {
  const fresh = String(Math.floor(Date.now() / 1000));
  assert.equal(verifyInitData(sign({ auth_date: fresh, user }, 'другой'), token), null);
  assert.equal(verifyInitData(sign({ auth_date: fresh, user }, token).replace('42', '43'), token), null);
  assert.equal(verifyInitData(sign({ auth_date: '1000', user }, token), token), null);
});
