'use strict';
/* BLOCKFIRE multiplayer relay server — no dependencies (Node 16+).
   Run:  node server.js            (port 8080, or set PORT=... )
   Serves index.html from the same folder, and relays game messages between
   players who share a 4-letter room code. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX = 10;
const HTML = path.join(__dirname, 'index.html');
const rooms = new Map();

/* ---- authoritative combat: weapon table mirrors the game (rate, range, falloff, damage) ---- */
const WTAB = {
  m4: { rate: .085, range: 300, fall0: 45, h: [40, 36], b: [34, 24] },
  ak: { rate: .1, range: 280, fall0: 40, h: [40, 35], b: [35, 25] },
  mp5: { rate: .07, range: 170, fall0: 25, h: [35, 18], b: [25, 14] },
  ump: { rate: .092, range: 190, fall0: 28, h: [33, 22], b: [28, 19] },
  sn: { rate: 1.3, range: 700, fall0: 200, h: [300, 245], b: [150, 125] },
  pistol: { rate: .42, range: 200, fall0: 25, h: [35, 27], b: [29, 20] },
};
const ARM_ABSORB = .6, REGEN_DELAY = 5, REGEN_RATE = 18;
function newSt() { return { hp: 100, arm: 50, dead: false, lastHit: 0 }; }
function enemies(r, a, b) { return r.mode === 'ffa' ? a !== b : (a.seat % 2) !== (b.seat % 2); }
/* ray vs vertical capsule (radius .5) of a player snapshot; returns {t, head} or null */
function rayCap(o, d, s, maxT) {
  const R = .5, top = s.y + 1.85 - .65 * (s.ch || 0), y0 = s.y;
  const fx = o[0] - s.x, fz = o[2] - s.z;
  const a = d[0] * d[0] + d[2] * d[2];
  if (a < 1e-9) return null;
  const b = 2 * (fx * d[0] + fz * d[2]), c = fx * fx + fz * fz - R * R;
  const disc = b * b - 4 * a * c; if (disc < 0) return null;
  let t = (-b - Math.sqrt(disc)) / (2 * a); if (t < 0) t = (-b + Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > maxT) return null;
  const y = o[1] + d[1] * t;
  if (y < y0 || y > top) return null;
  return { t, head: y > top - .6 };
}
function applyServerDamage(r, vic, att, dmg, head) {
  const st = vic.st; if (!st || st.dead) return;
  const now = Date.now();
  if (st.lastHit && now - st.lastHit > REGEN_DELAY * 1000) {   // lazy regen, mirrors the client rule
    const e = (now - st.lastHit) / 1000 - REGEN_DELAY;
    st.hp = Math.min(100, st.hp + REGEN_RATE * e); st.arm = Math.min(50, st.arm + REGEN_RATE * e);
  }
  st.lastHit = now;
  let amt = dmg;
  if (st.arm > 0) { const ab = Math.min(st.arm, amt * ARM_ABSORB); st.arm -= ab; amt -= ab; }
  st.hp -= amt;
  for (const m of r.members) m.send({ t: 'sdmg', to: vic.seat, from: att.seat, amt: dmg, head: head ? 1 : 0 });
  if (st.hp <= 0) {
    st.hp = 0; st.dead = true;
    for (const m of r.members) m.send({ t: 'skill', v: vic.seat, k: att.seat, h: head ? 1 : 0 });
  }
}
function resolveShot(c, m) {
  const r = c.room; if (!r || !r.started || !c.snap || !c.snap.alive || !c.st || c.st.dead) return;
  const w = WTAB[m.w]; if (!w) return;
  const now = Date.now(), minI = m.w === 'pistol' ? .05 : w.rate * .75;
  if (c.lastShot && now - c.lastShot < minI * 1000 - 15) return;
  c.lastShot = now;
  const o = [+m.ox, +m.oy, +m.oz], d = [+m.dx, +m.dy, +m.dz];
  if (![...o, ...d].every(Number.isFinite)) return;
  const L = Math.hypot(d[0], d[1], d[2]); if (L < .5 || L > 1.5) return;
  d[0] /= L; d[1] /= L; d[2] /= L;
  const s = c.snap;
  if (Math.hypot(o[0] - s.x, o[2] - s.z) > 3.5 || Math.abs(o[1] - (s.y + 1.6)) > 3) return;   // origin must be near the shooter
  let best = w.range, vic = null, head = false;
  for (const x of r.members) {
    if (x === c || !x.snap || !x.snap.alive || !x.st || x.st.dead || !enemies(r, c, x)) continue;
    const hit = rayCap(o, d, x.snap, best);
    if (hit && hit.t < best) { best = hit.t; vic = x; head = hit.head; }
  }
  // NOTE: walls are not modelled here (the map is generated in the browser), so wall hits are not yet rejected
  if (!vic) return;
  const fl = Math.max(0, Math.min(1, (best - w.fall0) / (w.range - w.fall0)));
  const T = head ? w.h : w.b;
  applyServerDamage(r, vic, c, Math.round((T[0] + (T[1] - T[0]) * fl) * 10) / 10, head);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  fs.readFile(HTML, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('index.html not found next to server.js'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  new Conn(sock);
});

class Conn {
  constructor(s) {
    this.s = s; this.buf = Buffer.alloc(0); this.room = null; this.seat = -1; this.name = 'PLAYER'; this.open = true;
    s.on('data', d => this.onData(d));
    s.on('close', () => this.close());
    s.on('error', () => this.close());
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const op = this.buf[0] & 15, masked = (this.buf[1] & 128) !== 0;
      let len = this.buf[1] & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { this.s.destroy(); return; }
      const mlen = masked ? 4 : 0;
      if (this.buf.length < off + mlen + len) return;
      let payload = this.buf.subarray(off + mlen, off + mlen + len);
      if (masked) {
        const m = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buf = this.buf.subarray(off + mlen + len);
      if (op === 1) this.onMsg(payload.toString('utf8'));
      else if (op === 8) { this.close(); return; }
      else if (op === 9) this.raw(10, payload);
    }
  }
  raw(op, payload) {
    if (!this.open) return;
    const n = payload.length; let h;
    if (n < 126) { h = Buffer.from([0x80 | op, n]); }
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    this.s.write(Buffer.concat([h, payload]));
  }
  send(o) { this.raw(1, Buffer.from(JSON.stringify(o))); }
  onMsg(text) {
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    handle(this, m);
  }
  close() {
    if (!this.open) return;
    this.open = false;
    leaveRoom(this);
    try { this.s.destroy(); } catch (e) {}
  }
}

function cleanName(v) { return String(v || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12) || 'PLAYER'; }
function freeSeat(r) { for (let s = 0; s < MAX; s++) if (!r.members.some(m => m.seat === s)) return s; return -1; }
function roster(r) { return r.members.map(m => ({ seat: m.seat, name: m.name })); }
function sendRoom(r) {
  for (const m of r.members) m.send({ t: 'room', code: r.code, seat: m.seat, host: r.host === m.seat, hs: r.host, players: roster(r) });
}
function newCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c; do { c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; } while (rooms.has(c));
  return c;
}
function leaveRoom(c) {
  const r = c.room; if (!r) return;
  c.room = null;
  const seat = c.seat; c.seat = -1;
  r.members = r.members.filter(m => m !== c);
  if (!r.members.length) { rooms.delete(r.code); return; }
  if (r.host === seat) r.host = r.members[0].seat;
  if (r.started) { for (const m of r.members) m.send({ t: 'left', seat }); }
  sendRoom(r);
}
function handle(c, m) {
  switch (m.t) {
    case 'create': {
      leaveRoom(c);
      c.name = cleanName(m.name);
      const r = { code: newCode(), host: 0, members: [], started: false };
      rooms.set(r.code, r);
      c.seat = 0; c.room = r; r.members.push(c); r.host = 0;
      sendRoom(r);
      return;
    }
    case 'join': {
      leaveRoom(c);
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) return c.send({ t: 'error', k: 'netNoRoom' });
      if (r.started) return c.send({ t: 'error', k: 'netStarted' });
      if (r.members.length >= MAX) return c.send({ t: 'error', k: 'netFull' });
      c.name = cleanName(m.name);
      c.seat = freeSeat(r); c.room = r; r.members.push(c);
      sendRoom(r);
      return;
    }
    case 'start': {
      const r = c.room; if (!r || r.host !== c.seat) return;
      if (r.members.length < 2) return c.send({ t: 'error', k: 'lobbyNeed' });
      r.started = true;
      const mode = m.mode === 'ffa' ? 'ffa' : 'tdm';
      r.mode = mode;
      for (const x of r.members) { x.st = newSt(); x.snap = null; }
      const limit = Math.max(1, Math.min(100, +m.limit || 30));
      const map = String(m.map || 'plaza').slice(0, 12);
      const msg = { t: 'start', mode, map, limit, players: roster(r) };
      for (const x of r.members) x.send(msg);
      return;
    }
    case 'ping': { c.send({ t: 'pong', ts: m.ts }); return; }
    case 'shot': { resolveShot(c, m); return; }
    case 'relay': {
      const r = c.room; if (!r || !r.started) return;
      if (m.d && m.d.t === 'snap') {
        const d = m.d;
        if ([d.x, d.y, d.z].every(Number.isFinite)) c.snap = { x: d.x, y: d.y, z: d.z, ch: +d.ch || 0, alive: !!d.alive };
        if (c.st && c.st.dead && d.alive) c.st = newSt();   // respawned: clear server-side death
      }
      const out = { t: 'relay', from: c.seat, d: m.d };
      for (const x of r.members) if (x !== c) x.send(out);
      return;
    }
    case 'vsig': {
      // voice-chat signalling: delivered only to the target seat, works in the lobby too
      const r = c.room; if (!r) return;
      const out = { t: 'vsig', from: c.seat, to: m.to, k: m.k, v: m.v };
      for (const x of r.members) if (x !== c && x.seat === m.to) x.send(out);
      return;
    }
    case 'done': {
      const r = c.room; if (!r) return;
      r.started = false; sendRoom(r);
      return;
    }
    case 'leave': leaveRoom(c); return;
  }
}

server.listen(PORT, () => console.log('BLOCKFIRE server on http://localhost:' + PORT));
