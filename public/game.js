'use strict';
// Sky Squad 클라이언트: 로비 UI + 입력 + 렌더링.
// 내 기체는 로컬에서 즉시 움직이고(반응성), 나머지는 서버 스냅샷 두 개를 보간해서 그린다.

const W = 480, H = 720;
const COLORS = ['#4de1ff', '#ffd24d', '#ff6bd6', '#7dff7a'];
const $ = id => document.getElementById(id);
const cv = $('c'), ctx = cv.getContext('2d');

let ws = null, myId = null, lobby = null;
let prev = null, cur = null;          // 서버 스냅샷 (보간용)
let me = { x: W / 2, y: H - 80, alive: false };
let particles = [], banner = null, lastWave = 0, shake = 0;
const keys = new Set();
const stars = Array.from({ length: 70 }, () => ({ x: Math.random() * W, y: Math.random() * H, s: 0.4 + Math.random() * 1.6 }));

// ---------- 화면 크기 ----------
function resize() {
  const s = Math.min(innerWidth / W, innerHeight / H), dpr = window.devicePixelRatio || 1;
  cv.style.width = W * s + 'px'; cv.style.height = H * s + 'px';
  cv.width = Math.round(W * s * dpr); cv.height = Math.round(H * s * dpr);
  ctx.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
}
addEventListener('resize', resize); resize();

// ---------- 로비 UI ----------
function show(id) { for (const k of ['menu', 'lobby', 'over']) $(k).hidden = k !== id; }
function setErr(m) { $('err').textContent = m || ''; }

$('name').value = localStorage.getItem('skysquad-name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);

function connect(first) {
  setErr('');
  const name = $('name').value.trim();
  localStorage.setItem('skysquad-name', name);
  first.name = name;
  if (ws) { ws.onclose = null; ws.close(); }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => ws.send(JSON.stringify(first));
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => { ws = null; lobby = null; prev = cur = null; show('menu'); setErr('서버와의 연결이 끊어졌습니다.'); };
}

$('create').onclick = () => connect({ t: 'create' });
$('join').onclick = () => {
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) return setErr('방 코드 4글자를 입력해 주세요.');
  connect({ t: 'join', code });
};
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
$('start').onclick = $('restart').onclick = () => ws && ws.send(JSON.stringify({ t: 'start' }));
$('copy').onclick = async () => {
  const link = location.origin + location.pathname + '?room=' + lobby.code;
  try { await navigator.clipboard.writeText(link); $('copy').textContent = '복사했습니다'; }
  catch { prompt('아래 링크를 복사해 친구에게 보내세요', link); }
  setTimeout(() => { $('copy').textContent = '초대 링크 복사'; }, 1500);
};

function playerRow(p, right) {
  const li = document.createElement('li');
  const dot = document.createElement('i'); dot.style.background = COLORS[p.slot];
  const nm = document.createElement('span'); nm.textContent = p.name + (p.id === myId ? ' (나)' : '');
  const b = document.createElement('b'); b.textContent = right;
  li.append(dot, nm, b);
  return li;
}

function onMessage(m) {
  if (m.t === 'err') { setErr(m.m); if (ws) { ws.onclose = null; ws.close(); ws = null; } }
  else if (m.t === 'joined') { myId = m.id; }
  else if (m.t === 'lobby') {
    const was = lobby && lobby.state;
    lobby = m;
    const host = m.host === myId;
    if (m.state === 'lobby') {
      $('roomcode').textContent = m.code;
      $('plist').replaceChildren(...m.players.map(p => playerRow(p, p.id === m.host ? '방장' : '')));
      $('start').hidden = !host;
      $('waitmsg').textContent = host ? `현재 ${m.players.length}명 · 혼자서도 시작할 수 있습니다` : '방장이 게임을 시작하기를 기다리는 중…';
      show('lobby');
    } else if (m.state === 'playing') {
      if (was !== 'playing') { prev = cur = null; particles = []; lastWave = 0; me.alive = false; }
      show(null);
    } else {
      $('result').textContent = `웨이브 ${cur ? cur.w : 0} · 팀 점수 ${cur ? cur.sc : 0}`;
      $('scores').replaceChildren(...[...m.players].sort((a, b) => b.score - a.score).map(p => playerRow(p, p.score + '점')));
      $('restart').hidden = !host;
      $('waitmsg2').textContent = host ? '' : '방장이 다시 시작하기를 기다리는 중…';
      show('over');
    }
  } else if (m.t === 's') onSnapshot(m);
}

// ---------- 스냅샷 ----------
function index(list) { const o = new Map(); for (const a of list) o.set(a[0], a); return o; }

function onSnapshot(m) {
  m.time = performance.now();
  m.P = index(m.p); m.E = index(m.e); m.B = index(m.b); m.EB = index(m.eb); m.PW = index(m.pw);
  prev = cur; cur = m;
  const mine = m.P.get(myId);
  if (mine) {
    const alive = !!mine[4];
    // 부활 직후이거나 서버 위치와 크게 어긋나면 서버 위치로 맞춘다
    if (alive && (!me.alive || Math.hypot(mine[1] - me.x, mine[2] - me.y) > 160)) { me.x = mine[1]; me.y = mine[2]; }
    me.alive = alive;
  }
  if (m.w !== lastWave) { lastWave = m.w; banner = { text: m.w % 5 === 0 ? 'BOSS' : 'WAVE ' + m.w, t: 2 }; }
  for (const [k, x, y] of m.ev) {
    if (k === 4) burst(x, y, 10, '#ffffff', 90);
    else if (k === 2) { burst(x, y, 8, '#ff6b7a', 140); shake = 0.15; }
    else { burst(x, y, k === 3 ? 70 : k === 1 ? 26 : 12, k === 3 ? '#ffd24d' : '#ff9a4d', k === 3 ? 320 : 200); if (k) shake = k === 3 ? 0.6 : 0.25; }
  }
}

function burst(x, y, n, color, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.2 + Math.random() * 0.8), life = 0.3 + Math.random() * 0.5;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color });
  }
}

// ---------- 입력 ----------
const KEYMAP = { ArrowLeft: 'l', a: 'l', A: 'l', ArrowRight: 'r', d: 'r', D: 'r', ArrowUp: 'u', w: 'u', W: 'u', ArrowDown: 'd', s: 'd', S: 'd' };
addEventListener('keydown', e => { const k = KEYMAP[e.key]; if (k && document.activeElement.tagName !== 'INPUT') { keys.add(k); e.preventDefault(); } });
addEventListener('keyup', e => { const k = KEYMAP[e.key]; if (k) keys.delete(k); });
addEventListener('blur', () => keys.clear());

let drag = null;
cv.addEventListener('pointerdown', e => { drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', e => {
  if (!drag || drag.id !== e.pointerId) return;
  const s = W / cv.getBoundingClientRect().width;
  if (me.alive) { me.x += (e.clientX - drag.x) * s; me.y += (e.clientY - drag.y) * s; clampMe(); }
  drag.x = e.clientX; drag.y = e.clientY;
});
const endDrag = e => { if (drag && drag.id === e.pointerId) drag = null; };
cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);

function clampMe() { me.x = Math.max(10, Math.min(W - 10, me.x)); me.y = Math.max(10, Math.min(H - 10, me.y)); }

setInterval(() => {
  if (ws && ws.readyState === 1 && lobby && lobby.state === 'playing' && me.alive) {
    ws.send(JSON.stringify({ t: 'in', x: Math.round(me.x), y: Math.round(me.y), f: 1 }));
  }
}, 33);

// ---------- 그리기 ----------
function poly(pts) { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.closePath(); }

function drawShip(x, y, color, name, blink, t) {
  ctx.save(); ctx.translate(x, y);
  if (blink && Math.floor(t * 12) % 2) ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#ff9a4d'; poly([-4, 12, 0, 18 + Math.sin(t * 40) * 4, 4, 12]); ctx.fill();
  ctx.fillStyle = color; poly([0, -18, 5, -4, 18, 8, 18, 12, 5, 9, 3, 14, -3, 14, -5, 9, -18, 12, -18, 8, -5, -4]); ctx.fill();
  ctx.fillStyle = '#04121a'; poly([0, -10, 3, -1, -3, -1]); ctx.fill();
  ctx.globalAlpha = 1;
  if (name) { ctx.fillStyle = color; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(name, 0, 32); }
  ctx.restore();
}

function drawEnemy(type, x, y, hp, t) {
  ctx.save(); ctx.translate(x, y);
  if (type === 0) { ctx.fillStyle = '#ff6b7a'; poly([0, 14, 12, -8, 5, -12, 0, -6, -5, -12, -12, -8]); ctx.fill(); }
  else if (type === 1) { ctx.fillStyle = '#c78bff'; poly([0, 14, 14, 0, 6, -12, -6, -12, -14, 0]); ctx.fill(); ctx.fillStyle = '#1b0b33'; ctx.fillRect(-4, -4, 8, 6); }
  else if (type === 2) { ctx.fillStyle = '#ff9a4d'; poly([0, 16, 8, 2, 16, -4, 16, -12, -16, -12, -16, -4, -8, 2]); ctx.fill(); ctx.fillStyle = '#fff3c4'; ctx.beginPath(); ctx.arc(0, -3, 4, 0, 7); ctx.fill(); }
  else if (type === 3) { ctx.fillStyle = '#6f86b8'; poly([-22, -16, 22, -16, 22, 6, 10, 22, -10, 22, -22, 6]); ctx.fill(); ctx.fillStyle = '#2b3a5c'; ctx.fillRect(-12, -8, 24, 12); }
  else {
    ctx.fillStyle = '#b3384b'; poly([0, 44, 30, 20, 46, -10, 34, -36, -34, -36, -46, -10, -30, 20]); ctx.fill();
    ctx.fillStyle = '#5a1422'; poly([0, 26, 18, 6, 12, -20, -12, -20, -18, 6]); ctx.fill();
    ctx.fillStyle = hp < 40 ? '#ffd24d' : '#ff6b7a'; ctx.beginPath(); ctx.arc(0, -2, 8 + Math.sin(t * 6) * 2, 0, 7); ctx.fill();
  }
  if ((type === 3 || type === 4) && hp < 100) {
    const w = type === 4 ? 90 : 40, yy = type === 4 ? -48 : -24;
    ctx.fillStyle = '#1a2242'; ctx.fillRect(-w / 2, yy, w, 4);
    ctx.fillStyle = '#7dff7a'; ctx.fillRect(-w / 2, yy, w * hp / 100, 4);
  }
  ctx.restore();
}

function lerpXY(map, a, i, k) { // 이전 스냅샷에 같은 id가 있으면 보간
  const b = map && map.get(a[0]);
  return b ? [b[i] + (a[i] - b[i]) * k, b[i + 1] + (a[i + 1] - b[i + 1]) * k] : [a[i], a[i + 1]];
}

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000), t = now / 1000; lastT = now;
  const playing = lobby && lobby.state !== 'lobby' && cur;

  if (lobby && lobby.state === 'playing' && me.alive) {
    const sp = 330 * dt;
    if (keys.has('l')) me.x -= sp; if (keys.has('r')) me.x += sp;
    if (keys.has('u')) me.y -= sp; if (keys.has('d')) me.y += sp;
    clampMe();
  }

  ctx.save();
  if (shake > 0) { shake -= dt; ctx.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8); }
  ctx.fillStyle = '#050816'; ctx.fillRect(-10, -10, W + 20, H + 20);
  for (const s of stars) {
    s.y += s.s * 60 * dt; if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
    ctx.fillStyle = `rgba(200,215,255,${0.25 + s.s * 0.3})`; ctx.fillRect(s.x, s.y, s.s, s.s * 2);
  }

  if (playing) {
    const k = prev ? Math.max(0, Math.min(1, (now - cur.time) / Math.max(16, cur.time - prev.time))) : 1;
    const names = new Map(lobby.players.map(p => [p.id, p]));

    for (const a of cur.pw) {
      const [x, y] = lerpXY(prev && prev.PW, a, 1, k);
      ctx.fillStyle = a[3] ? '#7dff7a' : '#4de1ff'; ctx.beginPath(); ctx.arc(x, y, 11 + Math.sin(t * 6) * 1.5, 0, 7); ctx.fill();
      ctx.fillStyle = '#04121a'; ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(a[3] ? '+' : 'P', x, y + 4.5);
    }
    for (const a of cur.b) {
      const [x, y] = lerpXY(prev && prev.B, a, 1, k);
      ctx.fillStyle = COLORS[a[3]]; ctx.fillRect(x - 1.5, y - 8, 3, 14);
    }
    for (const a of cur.e) { const [x, y] = lerpXY(prev && prev.E, a, 2, k); drawEnemy(a[1], x, y, a[4], t); }
    for (const a of cur.eb) {
      const [x, y] = lerpXY(prev && prev.EB, a, 1, k);
      ctx.fillStyle = '#ffd24d'; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fill();
      ctx.fillStyle = '#ff6b7a'; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill();
    }
    for (const a of cur.p) {
      if (!a[4]) continue;
      const info = names.get(a[0]); if (!info) continue;
      if (a[0] === myId) drawShip(me.x, me.y, COLORS[info.slot], '', a[8], t);
      else { const [x, y] = lerpXY(prev && prev.P, a, 1, k); drawShip(x, y, COLORS[info.slot], info.name, a[8], t); }
    }
  }

  particles = particles.filter(p => (p.life -= dt) > 0);
  for (const p of particles) {
    p.x += p.vx * dt; p.y += p.vy * dt;
    ctx.globalAlpha = p.life / p.max; ctx.fillStyle = p.color; ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  if (playing) drawHud(dt);
  requestAnimationFrame(frame);
}

function drawHud(dt) {
  const mine = cur.P.get(myId);
  ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#8f9ac7';
  ctx.fillText('WAVE ' + cur.w, 12, 24);
  ctx.textAlign = 'center'; ctx.fillStyle = '#e8ecff'; ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.fillText(String(cur.sc), W / 2, 26);

  // 팀원 목록
  ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'right';
  lobby.players.forEach((p, i) => {
    const a = cur.P.get(p.id); if (!a) return;
    ctx.fillStyle = COLORS[p.slot]; ctx.globalAlpha = a[4] ? 1 : 0.45;
    ctx.fillText(`${p.name}  ${a[4] ? a[6] : '부활 ' + a[5] + '초'}`, W - 12, 22 + i * 16);
  });
  ctx.globalAlpha = 1;

  if (mine) {
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < mine[3] ? '#ff6b7a' : '#1a2242';
      ctx.beginPath(); ctx.arc(18 + i * 18, H - 18, 6, 0, 7); ctx.fill();
    }
    ctx.textAlign = 'right'; ctx.fillStyle = '#4de1ff'; ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('무기 Lv.' + mine[7], W - 12, H - 14);
    if (!mine[4] && lobby.state === 'playing') {
      ctx.textAlign = 'center'; ctx.fillStyle = '#e8ecff'; ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText(`${mine[5]}초 후 부활`, W / 2, H / 2);
      ctx.font = '13px system-ui, sans-serif'; ctx.fillStyle = '#8f9ac7';
      ctx.fillText('팀원이 버티는 동안 다시 출격합니다', W / 2, H / 2 + 24);
    }
  }
  if (banner) {
    banner.t -= dt;
    if (banner.t <= 0) banner = null;
    else {
      ctx.globalAlpha = Math.min(1, banner.t); ctx.textAlign = 'center';
      ctx.fillStyle = banner.text === 'BOSS' ? '#ff6b7a' : '#4de1ff'; ctx.font = '800 40px system-ui, sans-serif';
      ctx.fillText(banner.text, W / 2, H / 3); ctx.globalAlpha = 1;
    }
  }
}

requestAnimationFrame(frame);
