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
const ACC = require('./accounts');
const ONLINE = new Map();   // serial -> Conn, for friend invites
/* ---- matchmaking: real players waiting for the same mode are grouped at random ---- */
const queues = { ffa: [], tdm: [], team: [], open: [] };
function dequeue(c) {
  if (!c.queued) return;
  const q = queues[c.queued]; if (q) { const i = q.indexOf(c); if (i >= 0) q.splice(i, 1); }
  c.queued = null;
}
function matchQueue(mode) {
  const q = queues[mode];
  while (q.length >= 2) {
    for (let i = q.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [q[i], q[j]] = [q[j], q[i]]; }
    const group = q.splice(0, Math.min(MAX, q.length));
    const host = group[0];
    /* open world: everyone in the room shares one world seed and the same broken resources */
    const r = { code: newCode(), host: 0, members: [], started: true, mode, map: host.qmap, limit: host.qlimit, seed: mode === 'open' ? crypto.randomInt(1, 2147483000) : 0, nodes: new Set() };
    rooms.set(r.code, r);
    group.forEach((c, i) => { c.queued = null; c.seat = i; c.room = r; c.st = newSt(); c.snap = null; r.members.push(c); });
    const msg = { t: 'start', mode, map: r.map, limit: r.limit, seed: r.seed, players: roster(r) };
    for (const x of r.members) x.send(msg);
  }
}

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
    if (this.acct && ONLINE.get(this.acct.serial) === this) ONLINE.delete(this.acct.serial);
    leaveRoom(this);
    try { this.s.destroy(); } catch (e) {}
  }
}

function cleanName(v) { return String(v || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12) || 'PLAYER'; }
function freeSeat(r) { for (let s = 0; s < MAX; s++) if (!r.members.some(m => m.seat === s)) return s; return -1; }
function roster(r) { return r.members.map(m => ({ seat: m.seat, name: m.name, cr: (m.acct && m.acct.perks && m.acct.perks.creator) ? (m.acct.perks.stars || 0) : -1 })); }
function sendRoom(r) {
  for (const m of r.members) m.send({ t: 'room', code: r.code, seat: m.seat, host: r.host === m.seat, hs: r.host, players: roster(r) });
}
function newCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c; do { c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; } while (rooms.has(c));
  return c;
}
function leaveRoom(c) {
  dequeue(c);
  const r = c.room; if (!r) return;
  c.room = null;
  const seat = c.seat; c.seat = -1;
  r.members = r.members.filter(m => m !== c);
  if (!r.members.length) { rooms.delete(r.code); return; }
  if (r.host === seat) r.host = r.members[0].seat;
  if (r.started) { for (const m of r.members) m.send({ t: 'left', seat }); }
  sendRoom(r);
}
function attachAcct(c, serial) {
  c.acct = ACC.accountBySerial(serial);
  if (c.acct) ONLINE.set(c.acct.serial, c);
}
function pushFriend(serial, msg) { const x = ONLINE.get(serial); if (x) x.send(msg); }
function accAction(c, m) {
  const a = c.acct;
  let r;
  switch (m.t) {
    case 'name': r = ACC.changeName(a, m.name); break;
    case 'avatar': r = ACC.setAvatar(a, m.img); break;
    case 'buy': r = ACC.buy(a, String(m.id || '')); break;
    case 'sell': r = ACC.sell(a, m.items || {}); break;
    case 'deposit': r = ACC.deposit(a, m.items || {}); break;
    case 'withdraw': r = ACC.withdraw(a, m.items || {}); break;
    case 'buyres': r = ACC.buyRes(a, String(m.id || ''), m.qty); break;
    case 'frreq': r = ACC.friendReq(a, m.serial); if (r.target) pushFriend(r.target.serial, { t: 'frnote', k: 'frGot', from: a.serial, name: a.name }); break;
    case 'fraccept': r = ACC.friendAccept(a, +m.serial); if (r.target) pushFriend(r.target.serial, { t: 'frnote', k: 'frAccepted', from: a.serial, name: a.name }); break;
    case 'frdecl': r = ACC.friendDecline(a, +m.serial); break;
    case 'frrm': r = ACC.friendRemove(a, +m.serial); break;
    case 'invite': {
      const f = (a.friends || []).includes(+m.serial);
      if (!f) return c.send({ t: 'error', k: 'frNotFriend' });
      if (!c.room) return c.send({ t: 'error', k: 'frNoLobby' });
      const t = ONLINE.get(+m.serial);
      if (!t) return c.send({ t: 'error', k: 'frOffline' });
      pushFriend(+m.serial, { t: 'invite', from: a.serial, name: a.name, code: c.room.code });
      return c.send({ t: 'acct', acc: ACC.view(a) });
    }
  }
  if (!r) return;
  if (r.err) return c.send({ t: 'error', k: r.err });
  if (r.got !== undefined) c.send({ t: 'sold', gold: r.got });
  return c.send({ t: 'acct', acc: r.acc, taken: r.taken, give: r.give });
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
    case 'queue': {
      leaveRoom(c);
      const mode = m.mode === 'tdm' ? 'tdm' : (m.mode === 'open' ? 'open' : 'ffa');
      c.name = cleanName(m.name);
      c.qmap = String(m.map || 'plaza').slice(0, 12);
      c.qlimit = Math.max(1, Math.min(100, +m.limit || 30));
      dequeue(c);
      c.queued = mode; queues[mode].push(c);
      matchQueue(mode);
      return;
    }
    case 'unqueue': dequeue(c); return;
    /* ---- accounts ---- */
    case 'register': {
      const r = ACC.register(m.email, m.pw, m.name);
      if (r.err) return c.send({ t: 'error', k: r.err });
      attachAcct(c, r.acc.serial); return c.send({ t: 'acct', token: r.token, acc: r.acc });
    }
    case 'login': {
      const r = ACC.login(m.email, m.pw);
      if (r.err) return c.send({ t: 'error', k: r.err });
      attachAcct(c, r.acc.serial); return c.send({ t: 'acct', token: r.token, acc: r.acc });
    }
    case 'session': {
      const a = ACC.session(String(m.token || ''));
      if (!a) return c.send({ t: 'error', k: 'accSessionBad' });
      attachAcct(c, a.serial); return c.send({ t: 'acct', acc: a });
    }
    case 'redeem': {
      if (!c.acct) return c.send({ t: 'error', k: 'accNeedLogin' });
      const r = ACC.redeem(c.acct, m.code);
      return c.send(r.err ? { t: 'error', k: r.err } : { t: 'acct', acc: r.acc });
    }
    case 'claim': {
      if (!c.acct) return c.send({ t: 'error', k: 'accNeedLogin' });
      const r = ACC.claimMail(c.acct, String(m.id || ''));
      return c.send(r.err ? { t: 'error', k: r.err } : { t: 'acct', acc: r.acc });
    }
    case 'sync': {
      if (!c.acct) return c.send({ t: 'error', k: 'accNeedLogin' });
      return c.send({ t: 'acct', acc: ACC.mergeSnap(c.acct, m.snap) });
    }
    case 'node': {
      /* open world: a resource broken by one player is broken for the whole room */
      const r = c.room; if (!r || !r.started || r.mode !== 'open') return;
      const id = Math.floor(+m.id); if (!(id >= 0 && id < 100000)) return;
      if (r.nodes.has(id)) return;
      r.nodes.add(id);
      for (const x of r.members) if (x !== c) x.send({ t: 'node', id });
      return;
    }
    case 'chat': {
      /* room chat: everyone in the same room (lobby or match) gets the message; outside a room it is not sent */
      const text = String(m.text || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 160);
      if (!text) return;
      const from = (c.name || 'PLAYER').slice(0, 12);
      const r = c.room; if (!r) return c.send({ t: 'error', k: 'chatNoRoom' });
      const now = Date.now(); c.chatT = (c.chatT || []).filter(t => now - t < 10000);
      if (c.chatT.length >= 5) return c.send({ t: 'error', k: 'chatSlow' });
      c.chatT.push(now);
      for (const x of r.members) x.send({ t: 'chat', from, seat: c.seat, text });
      return;
    }
    case 'name': case 'avatar': case 'buy': case 'sell': case 'deposit': case 'withdraw': case 'buyres': case 'frreq': case 'fraccept': case 'frdecl': case 'frrm': case 'invite': {
      if (!c.acct) return c.send({ t: 'error', k: 'accNeedLogin' });
      return accAction(c, m);
    }
    case 'devgen': {
      const r = ACC.devGen(String(m.key || ''), m.kind, m.reward || {}, m.count);
      return c.send(r.err ? { t: 'error', k: r.err } : { t: 'devcodes', codes: r.codes });
    }    case 'leave': leaveRoom(c); return;
  }
}

server.listen(PORT, () => console.log('BLOCKFIRE server on http://localhost:' + PORT));
