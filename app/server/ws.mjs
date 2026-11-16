// Минимальный WebSocket-сервер (RFC 6455) без зависимостей: только текстовые сообщения.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024;

export class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.open = true;
    this.alive = true;
    sock.setNoDelay(true);
    sock.on('data', d => this.#onData(d));
    sock.on('close', () => this.#closed());
    sock.on('error', () => this.#closed());
  }
  send(text) {
    if (!this.open) return;
    const payload = Buffer.from(text);
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x81, n])
      : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    this.sock.write(Buffer.concat([head, payload]));
  }
  ping() { if (this.open) this.sock.write(Buffer.from([0x89, 0])); }
  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(4); b[0] = 0x88; b[1] = 2; b.writeUInt16BE(code, 2);
    try { this.sock.end(b); } catch { /* сокет уже закрыт */ }
    this.#closed();
  }
  #closed() {
    if (!this.open) return;
    this.open = false;
    this.sock.destroy();
    this.emit('close');
  }
  #onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009);
        len = Number(big); off = 10;
      }
      if (!masked) return this.close(1002);           // клиент обязан маскировать
      if (len > MAX_MESSAGE) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.alive = true;
      if (op === 0x8) return this.close();
      if (op === 0x9) { this.sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        this.frag.push(data);
        const total = this.frag.reduce((s, x) => s + x.length, 0);
        if (total > MAX_MESSAGE) return this.close(1009);
        if (fin) { const msg = Buffer.concat(this.frag).toString('utf8'); this.frag = []; this.emit('message', msg); }
      } else return this.close(1003);
    }
  }
}

// Принимает HTTP upgrade и отдаёт Socket в onSocket.
export function attach(server, path, onSocket) {
  server.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || req.headers.upgrade?.toLowerCase() !== 'websocket') { sock.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    onSocket(new Socket(sock), req);
  });
  // Пинг каждые 25 секунд: телефоны и прокси иначе рвут молчащие соединения.
  const all = new Set();
  const t = setInterval(() => {
    for (const s of all) { if (!s.alive) { s.close(1001); continue; } s.alive = false; s.ping(); }
  }, 25000);
  t.unref();
  return { track: s => { all.add(s); s.on('close', () => all.delete(s)); } };
}
