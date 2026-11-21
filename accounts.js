'use strict';
/* BLOCKFIRE accounts: serial numbers, email+password (instant signup), gold, redeem codes, dev code generator.
   Storage: a JSON file in DATA_DIR (default ./data). On hosts with an ephemeral disk this resets on restart. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA, 'db.json');
const DEV_KEY = process.env.DEV_KEY || 'kouadri#2008';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let db = { next: 1, accounts: {}, codes: {}, sessions: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first run */ }
let saveT = null;
function save() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try { fs.mkdirSync(DATA, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); } catch (e) { console.error('save failed', e.message); }
  }, 300);
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function cleanEmail(e) { e = String(e || '').trim().toLowerCase(); return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(e) ? e : null; }
function view(a) { return { serial: a.serial, email: a.email, name: a.name, gold: a.gold, items: a.items, mail: a.mail, avatar: a.avatar || null, friends: a.friends || [], reqIn: a.reqIn || [], reqOut: a.reqOut || [], nameAt: a.nameAt || 0, avAt: a.avAt || 0, synced: !!a.synced, perks: a.perks || {}, hacks: a.hacks || [], codes: a.codes || [] }; }
const DAY = 86400000, FREE_EVERY = 14 * DAY, CHANGE_COST = 1000;
const ITEM_MULT = { common: 1, rare: 2, epic: 4, legendary: 8 };
const ITEM_RARITY = { iron: 'common', coal: 'common', wood: 'common', stone: 'common', gold_ore: 'rare', diamond: 'epic' };
/* shop: server-side prices; gold is deducted here so a later device sync cannot restore it */
const SHOP = { gold_m4: { price: 5000, what: 'skin' }, gold_ak: { price: 5000, what: 'skin' }, gold_awm: { price: 9000, what: 'skin' } };


function register(email, pw, name) {
  email = cleanEmail(email);
  if (!email) return { err: 'accBadEmail' };
  if (String(pw || '').length < 6) return { err: 'accShortPw' };
  if (Object.values(db.accounts).some(a => a.email === email)) return { err: 'accExists' };
  const salt = crypto.randomBytes(16).toString('hex');
  const serial = db.next++;
  const acc = { serial, email, name: String(name || 'PLAYER').slice(0, 12), salt, pw: hashPw(pw, salt), gold: 0, items: {}, mail: [], redeemed: [], created: Date.now() };
  db.accounts[serial] = acc;
  return login(email, pw, true, acc);
}
function login(email, pw, _fresh, acc) {
  email = cleanEmail(email);
  acc = acc || Object.values(db.accounts).find(a => a.email === email);
  if (!acc || hashPw(pw, acc.salt) !== acc.pw) return { err: 'accBadLogin' };
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = acc.serial;
  save();
  return { token, acc: view(acc) };
}
function session(token) {
  const serial = db.sessions[token];
  const acc = serial && db.accounts[serial];
  return acc ? view(acc) : null;
}
function accountBySerial(serial) { return db.accounts[serial] || null; }

function mkCode(len) { let c = ''; for (let i = 0; i < len; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; return c; }
/* reward: { gold, items: {id:n}, title } ; kind: 'single' (one account, once) | 'group' (each account once, goes to mailbox) */
function devGen(key, kind, reward, count) {
  if (key !== DEV_KEY) return { err: 'devBadKey' };
  kind = kind === 'group' ? 'group' : 'single';
  count = Math.max(1, Math.min(200, +count || 1));
  const out = [];
  for (let i = 0; i < count; i++) {
    let c; do { c = mkCode(14); } while (db.codes[c]);
    const HK = ['head', 'god', 'speed', 'jump', 'wall'];
    const pr = reward.perks || reward;
    const perks = { creator: !!pr.creator, stars: Math.max(0, Math.min(5, +pr.stars || 0)), nameFree: +pr.nameFree || 0 };
    const hacks = (reward.hacks || []).filter(h => HK.includes(h));
    db.codes[c] = { kind, reward: { gold: +reward.gold || 0, items: reward.items || {}, title: String(reward.title || '').slice(0, 40), perks, hacks }, used: [] };
    out.push(c);
  }
  save();
  return { codes: out };
}
function redeem(acc, code) {
  code = String(code || '').trim().toUpperCase();
  const c = db.codes[code];
  if (!c) return { err: 'codeNone' };
  if (c.kind === 'single') {
    if (c.used.length) return { err: 'codeUsed' };
    c.used.push(acc.serial); credit(acc, c.reward); acc.codes = [...(acc.codes || []), code];   // kept forever: a single code can never be used again
  } else {
    if (c.used.includes(acc.serial)) return { err: 'codeAlready' };
    c.used.push(acc.serial); acc.codes = [...(acc.codes || []), code];
    acc.mail.push({ id: crypto.randomBytes(6).toString('hex'), code, gold: c.reward.gold, items: c.reward.items, title: c.reward.title, at: Date.now() });
  }
  save();
  return { acc: view(acc) };
}
function credit(acc, r) {
  acc.gold += r.gold || 0;
  if (r.perks) { const p = acc.perks || {}; if (r.perks.creator) p.creator = true; if (r.perks.stars) p.stars = Math.max(p.stars || 0, r.perks.stars); if (r.perks.nameFree) p.nameFree = (p.nameFree || 0) + 1; acc.perks = p; }
  if (r.hacks && r.hacks.length) acc.hacks = [...new Set([...(acc.hacks || []), ...r.hacks])];
  for (const k in (r.items || {})) acc.items[k] = (acc.items[k] || 0) + r.items[k];
}
function claimMail(acc, id) {
  const i = acc.mail.findIndex(m => m.id === id);
  if (i < 0) return { err: 'mailNone' };
  const m = acc.mail.splice(i, 1)[0];
  credit(acc, m);
  save();
  return { acc: view(acc) };
}
/* merge a device snapshot into the server copy: never lowers progress (max gold, max item counts, mailbox stays on the server) */
function mergeSnap(acc, snap) {
  snap = snap || {};
  acc.gold = Math.max(acc.gold, Math.floor(+snap.gold || 0));
  for (const k in (snap.items || {})) acc.items[k] = Math.max(acc.items[k] || 0, Math.floor(+snap.items[k] || 0));
  /* mailbox is server-only, so rewards cannot be duplicated by a device */
  save();
  return view(acc);
}
function addGold(acc, n) { acc.gold = Math.max(0, acc.gold + (+n || 0)); save(); return view(acc); }

/* sync: the first upload may set gold/items (device progress); later uploads only add what the device reports as earned since the last sync */
function mergeSnap(acc, snap) {
  snap = snap || {};
  if (!acc.synced) {
    acc.gold = Math.max(acc.gold, Math.floor(+snap.gold || 0));
    for (const k in (snap.items || {})) acc.items[k] = Math.max(acc.items[k] || 0, Math.floor(+snap.items[k] || 0));
    acc.synced = true;
  } else {
    const earned = Math.max(0, Math.min(1e6, Math.floor(+snap.earned || 0)));
    acc.gold += earned;
    for (const k in (snap.gained || {})) acc.items[k] = (acc.items[k] || 0) + Math.max(0, Math.min(1e5, Math.floor(+snap.gained[k] || 0)));
  }
  save();
  return view(acc);
}
function changeName(acc, name) {
  name = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12);
  if (!name) return { err: 'accBadName' };
  const free = Date.now() - (acc.nameAt || 0) >= FREE_EVERY;
  if (acc.perks && acc.perks.nameFree > 0) { acc.perks.nameFree--; }
  else if (!free) { if (acc.gold < CHANGE_COST) return { err: 'accNoGold' }; acc.gold -= CHANGE_COST; }
  acc.name = name; acc.nameAt = Date.now(); save();
  return { acc: view(acc) };
}
function setAvatar(acc, img) {
  img = String(img || '');
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(img) || img.length > 90000) return { err: 'accBadAvatar' };
  const free = Date.now() - (acc.avAt || 0) >= FREE_EVERY;
  if (!free) { if (acc.gold < CHANGE_COST) return { err: 'accNoGold' }; acc.gold -= CHANGE_COST; }
  acc.avatar = img; acc.avAt = Date.now(); save();
  return { acc: view(acc) };
}
function buy(acc, id) {
  const it = SHOP[id]; if (!it) return { err: 'shopNone' };
  if (acc.gold < it.price) return { err: 'accNoGold' };
  acc.gold -= it.price; acc.items[id] = (acc.items[id] || 0) + 1; save();
  return { acc: view(acc) };
}
/* selling: 100 units pay 50 gold, scaled by rarity */
function sell(acc, items) {
  let gold = 0;
  for (const k in (items || {})) {
    const n = Math.floor(+items[k] || 0); if (n <= 0 || (acc.items[k] || 0) < n) return { err: 'shopNotEnough' };
    gold += (n / 100) * 50 * (ITEM_MULT[ITEM_RARITY[k] || 'common'] || 1);
  }
  for (const k in (items || {})) acc.items[k] -= Math.floor(+items[k]);
  acc.gold += Math.floor(gold); save();
  return { acc: view(acc), got: Math.floor(gold) };
}
function findBy(serial) { return Object.values(db.accounts).find(a => a.serial === +serial) || null; }
function friendReq(acc, serial) {
  serial = +serial; if (!serial || serial === acc.serial) return { err: 'frSelf' };
  const t = db.accounts[serial]; if (!t) return { err: 'frNone' };
  acc.friends = acc.friends || []; acc.reqIn = acc.reqIn || []; acc.reqOut = acc.reqOut || []; t.friends = t.friends || []; t.reqIn = t.reqIn || []; t.reqOut = t.reqOut || [];
  if (acc.friends.includes(serial)) return { err: 'frAlready' };
  if (acc.reqIn.includes(serial)) return friendAccept(acc, serial);
  if (!acc.reqOut.includes(serial)) acc.reqOut.push(serial);
  if (!t.reqIn.includes(acc.serial)) t.reqIn.push(acc.serial);
  save(); return { acc: view(acc), target: t };
}
function friendAccept(acc, serial) {
  const t = db.accounts[serial]; if (!t) return { err: 'frNone' };
  acc.reqIn = (acc.reqIn || []).filter(x => x !== serial); t.reqOut = (t.reqOut || []).filter(x => x !== acc.serial);
  acc.friends = [...new Set([...(acc.friends || []), serial])]; t.friends = [...new Set([...(t.friends || []), acc.serial])];
  save(); return { acc: view(acc), target: t };
}
function friendDecline(acc, serial) {
  const t = db.accounts[serial];
  acc.reqIn = (acc.reqIn || []).filter(x => x !== serial);
  if (t) t.reqOut = (t.reqOut || []).filter(x => x !== acc.serial);
  save(); return { acc: view(acc) };
}
function friendRemove(acc, serial) {
  const t = db.accounts[serial];
  acc.friends = (acc.friends || []).filter(x => x !== serial);
  if (t) t.friends = (t.friends || []).filter(x => x !== acc.serial);
  save(); return { acc: view(acc) };
}
module.exports = { mergeSnap, changeName, setAvatar, buy, sell, findBy, friendReq, friendAccept, friendDecline, friendRemove, SHOP, register, login, session, accountBySerial, devGen, redeem, claimMail, addGold, view, save };
