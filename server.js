'use strict';
// 온라인 협동 슈팅 게임 서버.
// 정적 파일 제공 + WebSocket 방 관리 + 게임 시뮬레이션(서버 권위)을 모두 담당한다.
// 플레이어 자신의 위치만 클라이언트가 보고하고(속도 제한으로 검증), 나머지는 전부 서버가 계산한다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 480, H = 720;
const TICK = 30, DT = 1 / TICK;
const MAX_PLAYERS = 4;
const PLAYER_R = 10, BULLET_R = 4;
const MAX_SPEED = 700; // 서버가 허용하는 플레이어 최대 이동 속도(px/s)
const TYPES = ['grunt', 'zig', 'shooter', 'tank', 'boss'];

// ---------- 정적 파일 ----------
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- 방 ----------
const rooms = new Map();
let nextPlayerId = 1;

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}

function newRoom() {
  const room = { code: makeCode(), players: new Map(), host: null, state: 'lobby' };
  resetGame(room);
  rooms.set(room.code, room);
  return room;
}

function resetGame(room) {
  Object.assign(room, { enemies: [], pb: [], eb: [], pw: [], ev: [], queue: [], wave: 0, waveT: 0, breakT: 2, score: 0, eid: 1 });
  const list = [...room.players.values()];
  list.forEach((p, i) => spawnPlayer(p, i, list.length));
}

function spawnPlayer(p, idx, n) {
  Object.assign(p, { x: W * (idx + 1) / (n + 1), y: H - 80, hp: 3, alive: true, inv: 2, respawn: 0, lvl: 1, cd: 0, score: 0, fire: false });
  p.tx = p.x; p.ty = p.y;
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
function sendLobby(room) {
  broadcast(room, {
    t: 'lobby', code: room.code, host: room.host, state: room.state,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot, score: p.score })),
  });
}

function addPlayer(room, ws, name) {
  const used = new Set([...room.players.values()].map(p => p.slot));
  let slot = 0; while (used.has(slot)) slot++;
  const p = { id: nextPlayerId++, ws, name, slot };
  spawnPlayer(p, slot, MAX_PLAYERS);
  room.players.set(p.id, p);
  if (room.host === null) room.host = p.id;
  ws.player = p; ws.room = room;
  send(ws, { t: 'joined', id: p.id, code: room.code });
  sendLobby(room);
}

function removePlayer(ws) {
  const room = ws.room, p = ws.player;
  if (!room || !p) return;
  ws.room = ws.player = null;
  room.players.delete(p.id);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.host === p.id) room.host = room.players.keys().next().value;
  sendLobby(room);
}

function cleanName(n) {
  n = String(n == null ? '' : n).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return n || '파일럿';
}

// ---------- 네트워크 ----------
const wss = new WebSocketServer({ server, maxPayload: 1024 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const room = ws.room, p = ws.player;
    switch (m.t) {
      case 'create':
        if (room) return;
        addPlayer(newRoom(), ws, cleanName(m.name));
        break;
      case 'join': {
        if (room) return;
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'err', m: '방을 찾을 수 없습니다. 코드를 확인해 주세요.' });
        if (r.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', m: '방이 가득 찼습니다 (최대 4명).' });
        addPlayer(r, ws, cleanName(m.name));
        break;
      }
      case 'start':
        if (!room || room.host !== p.id || room.state === 'playing') return;
        resetGame(room);
        room.state = 'playing';
        sendLobby(room);
        break;
      case 'in':
        if (!p || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
        p.tx = m.x; p.ty = m.y; p.fire = !!m.f;
        break;
    }
  });
  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => {});
});

// 끊어진 연결 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000);

// ---------- 게임 로직 ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);

function buildWave(room) {
  room.wave++;
  const w = room.wave, n = room.players.size, q = [];
  if (w % 5 === 0) {
    q.push({ t: 1, type: 'boss' });
    for (let i = 0; i < 4 + n * 2; i++) q.push({ t: 4 + i * 1.6, type: 'grunt' });
  } else {
    const pool = ['grunt', 'grunt', 'grunt', 'grunt'];
    if (w >= 2) pool.push('zig', 'zig', 'zig');
    if (w >= 3) pool.push('shooter', 'shooter');
    if (w >= 4) pool.push('tank');
    const count = Math.round((6 + w * 2) * (0.6 + 0.4 * n));
    const gap = Math.max(0.25, 0.9 - w * 0.04) / (0.7 + 0.3 * n);
    let t = 0;
    for (let i = 0; i < count; i++) {
      t += gap * rnd(0.6, 1.4);
      q.push({ t, type: pool[Math.floor(Math.random() * pool.length)] });
    }
  }
  room.queue = q; room.waveT = 0; room.breakT = 3;
}

function spawnEnemy(room, type) {
  const w = room.wave, hs = 1 + 0.35 * (room.players.size - 1);
  const e = { id: room.eid++, type, x: rnd(30, W - 30), y: -30, t: 0, cd: rnd(0.8, 1.8) };
  if (type === 'grunt') Object.assign(e, { hp: 2, r: 14, vy: 110 + w * 4, pts: 10 });
  else if (type === 'zig') Object.assign(e, { hp: 2, r: 14, vy: 90 + w * 2, x0: clamp(e.x, 100, W - 100), pts: 15 });
  else if (type === 'shooter') Object.assign(e, { hp: 4, r: 16, ty: rnd(110, 270), vx: Math.random() < 0.5 ? -60 : 60, pts: 25 });
  else if (type === 'tank') Object.assign(e, { hp: Math.round(12 * hs), r: 22, vy: 45, pts: 40 });
  else Object.assign(e, { x: W / 2, y: -60, hp: Math.round((160 + 12 * w) * hs), r: 46, pts: 500, bt: 0, cd2: 3 });
  e.maxHp = e.hp;
  room.enemies.push(e);
}

function enemyShot(room, e, angle, speed) {
  room.eb.push({ id: room.eid++, x: e.x, y: e.y + e.r * 0.6, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
}

// 가장 가까운 생존 플레이어를 향한 각도. 없으면 아래쪽.
function aimAngle(room, e) {
  let best = null, bd = Infinity;
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const d = (p.x - e.x) ** 2 + (p.y - e.y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best ? Math.atan2(best.y - e.y, best.x - e.x) : Math.PI / 2;
}

function hurt(room, p) {
  if (!p.alive || p.inv > 0) return;
  p.hp--; p.inv = 1.5;
  if (p.hp <= 0) {
    p.alive = false; p.respawn = 6; p.lvl = Math.max(1, p.lvl - 1);
    room.ev.push([1, Math.round(p.x), Math.round(p.y)]);
  } else {
    room.ev.push([2, Math.round(p.x), Math.round(p.y)]);
  }
}

function killEnemy(room, e, by) {
  e.dead = true;
  room.score += e.pts;
  if (by) by.score += e.pts;
  room.ev.push([e.type === 'boss' ? 3 : e.r > 20 ? 1 : 0, Math.round(e.x), Math.round(e.y)]);
  const drops = e.type === 'boss' ? 3 : Math.random() < (e.type === 'tank' ? 0.5 : 0.12) ? 1 : 0;
  for (let i = 0; i < drops; i++) {
    room.pw.push({ id: room.eid++, x: clamp(e.x + (i - (drops - 1) / 2) * 40, 20, W - 20), y: e.y, k: Math.random() < 0.7 ? 0 : 1 });
  }
}

function tickRoom(room) {
  const players = [...room.players.values()];
  const speedCap = Math.min(280, 190 + room.wave * 3);

  // 플레이어
  for (const p of players) {
    if (!p.alive) {
      p.respawn -= DT;
      if (p.respawn <= 0 && players.some(o => o.alive)) {
        Object.assign(p, { alive: true, hp: 3, inv: 3, x: W / 2, y: H - 80, tx: W / 2, ty: H - 80 });
      }
      continue;
    }
    const dx = clamp(p.tx, PLAYER_R, W - PLAYER_R) - p.x, dy = clamp(p.ty, PLAYER_R, H - PLAYER_R) - p.y;
    const d = Math.hypot(dx, dy), max = MAX_SPEED * DT;
    if (d <= max) { p.x += dx; p.y += dy; } else { p.x += dx / d * max; p.y += dy / d * max; }
    if (p.inv > 0) p.inv -= DT;
    p.cd -= DT;
    if (p.fire && p.cd <= 0) {
      p.cd = p.lvl >= 4 ? 0.11 : 0.15;
      const shots = p.lvl === 1 ? [[0, 0]] : p.lvl === 2 ? [[-7, 0], [7, 0]] : [[-8, -90], [0, 0], [8, 90]];
      for (const [ox, vx] of shots) room.pb.push({ id: room.eid++, x: p.x + ox, y: p.y - 14, vx, vy: -720, o: p, c: p.slot });
    }
  }

  // 웨이브 진행
  if (room.queue.length === 0 && room.enemies.length === 0) {
    room.breakT -= DT;
    if (room.breakT <= 0) buildWave(room);
  } else {
    room.waveT += DT;
    while (room.queue.length && room.queue[0].t <= room.waveT) spawnEnemy(room, room.queue.shift().type);
  }

  // 적
  for (const e of room.enemies) {
    e.t += DT;
    if (e.type === 'grunt') e.y += e.vy * DT;
    else if (e.type === 'zig') { e.y += e.vy * DT; e.x = e.x0 + Math.sin(e.t * 3) * 80; }
    else if (e.type === 'shooter') {
      if (e.t > 9) e.y += 160 * DT;
      else if (e.y < e.ty) e.y += 140 * DT;
      else {
        e.x += e.vx * DT;
        if (e.x < 24 || e.x > W - 24) { e.vx = -e.vx; e.x = clamp(e.x, 24, W - 24); }
        e.cd -= DT;
        if (e.cd <= 0) { e.cd = 1.8; enemyShot(room, e, aimAngle(room, e), speedCap); }
      }
    } else if (e.type === 'tank') {
      e.y += e.vy * DT; e.cd -= DT;
      if (e.cd <= 0 && e.y > 0) { e.cd = 2.2; for (const a of [-0.3, 0, 0.3]) enemyShot(room, e, Math.PI / 2 + a, speedCap * 0.85); }
    } else { // boss
      if (e.y < 130) e.y += 60 * DT;
      else {
        const rage = e.hp < e.maxHp * 0.4 ? 0.65 : 1;
        e.bt += DT; e.x = W / 2 + Math.sin(e.bt * 0.8) * 150;
        e.cd -= DT; e.cd2 -= DT;
        if (e.cd <= 0) { e.cd = 1.3 * rage; const a = aimAngle(room, e); for (const o of [-0.22, 0, 0.22]) enemyShot(room, e, a + o, speedCap); }
        if (e.cd2 <= 0) { e.cd2 = 3 * rage; const off = Math.random() * Math.PI; for (let i = 0; i < 12; i++) enemyShot(room, e, off + i * Math.PI / 6, speedCap * 0.7); }
      }
    }
    if (e.y > H + 60) e.gone = true;
    for (const p of players) {
      if (p.alive && p.inv <= 0 && Math.hypot(p.x - e.x, p.y - e.y) < e.r + PLAYER_R) {
        hurt(room, p);
        if (e.type !== 'boss' && !e.dead) { e.hp -= 5; if (e.hp <= 0) killEnemy(room, e, p); }
      }
    }
  }

  // 아군 탄
  for (const b of room.pb) {
    b.x += b.vx * DT; b.y += b.vy * DT;
    if (b.y < -20 || b.x < -20 || b.x > W + 20) { b.gone = true; continue; }
    for (const e of room.enemies) {
      if (e.dead || e.gone) continue;
      if (Math.abs(b.x - e.x) < e.r + BULLET_R && Math.abs(b.y - e.y) < e.r + BULLET_R + 8) {
        b.gone = true; e.hp--;
        if (e.hp <= 0) killEnemy(room, e, room.players.has(b.o.id) ? b.o : null);
        break;
      }
    }
  }

  // 적 탄
  for (const b of room.eb) {
    b.x += b.vx * DT; b.y += b.vy * DT;
    if (b.y < -30 || b.y > H + 30 || b.x < -30 || b.x > W + 30) { b.gone = true; continue; }
    for (const p of players) {
      if (p.alive && p.inv <= 0 && Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_R + BULLET_R) { hurt(room, p); b.gone = true; break; }
    }
  }

  // 아이템: 0 = 무기 강화, 1 = 체력 회복
  for (const it of room.pw) {
    it.y += 90 * DT;
    if (it.y > H + 20) { it.gone = true; continue; }
    for (const p of players) {
      if (p.alive && Math.hypot(p.x - it.x, p.y - it.y) < 26) {
        it.gone = true;
        if (it.k === 1) p.hp = Math.min(5, p.hp + 1);
        else if (p.lvl < 4) p.lvl++;
        else { p.score += 50; room.score += 50; }
        room.ev.push([4, Math.round(it.x), Math.round(it.y)]);
        break;
      }
    }
  }

  room.enemies = room.enemies.filter(e => !e.dead && !e.gone);
  room.pb = room.pb.filter(b => !b.gone);
  room.eb = room.eb.filter(b => !b.gone);
  room.pw = room.pw.filter(i => !i.gone);

  const over = players.length > 0 && players.every(p => !p.alive);
  if (over) room.state = 'over';

  const R = Math.round;
  broadcast(room, {
    t: 's', w: room.wave, sc: room.score,
    p: players.map(p => [p.id, R(p.x), R(p.y), p.hp, p.alive ? 1 : 0, Math.max(0, Math.ceil(p.respawn)), p.score, p.lvl, p.inv > 0 ? 1 : 0]),
    e: room.enemies.map(e => [e.id, TYPES.indexOf(e.type), R(e.x), R(e.y), R(e.hp / e.maxHp * 100)]),
    b: room.pb.map(b => [b.id, R(b.x), R(b.y), b.c]),
    eb: room.eb.map(b => [b.id, R(b.x), R(b.y)]),
    pw: room.pw.map(i => [i.id, R(i.x), R(i.y), i.k]),
    ev: room.ev,
  });
  room.ev = [];
  if (over) sendLobby(room);
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state !== 'playing') continue;
    try { tickRoom(room); } catch (err) { console.error('tick error', room.code, err); }
  }
}, 1000 / TICK);

server.listen(PORT, () => console.log(`Sky Squad 서버 실행 중: http://localhost:${PORT}`));
