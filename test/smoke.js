'use strict';
// 스모크 테스트: 서버를 띄우고 두 클라이언트가 방을 만들고 참가해 게임 스냅샷을 받는지 확인한다.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3999;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT }, stdio: 'inherit' });
const fail = m => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
const timer = setTimeout(() => fail('timeout'), 15000);

function client(first, onMsg) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => ws.send(JSON.stringify(first)));
  ws.on('message', d => onMsg(JSON.parse(d), ws));
  ws.on('error', e => fail(e.message));
  return ws;
}

setTimeout(() => {
  let b = null, snaps = 0, sawEnemy = false, sawBullet = false, aId = null;
  const a = client({ t: 'create', name: 'A' }, (m, ws) => {
    if (m.t === 'joined') {
      aId = m.id;
      client({ t: 'join', code: 'ZZZZ', name: 'X' }, e => { if (e.t !== 'err') fail('bad code should error'); });
      b = client({ t: 'join', code: m.code, name: 'B' }, () => {});
    }
    if (m.t === 'lobby' && m.state === 'lobby' && m.players.length === 2) ws.send(JSON.stringify({ t: 'start' }));
    if (m.t === 's') {
      if (snaps++ === 0) setInterval(() => ws.send(JSON.stringify({ t: 'in', x: 240, y: 600, f: 1 })), 33);
      if (m.p.length !== 2) fail('expected 2 players in snapshot');
      if (m.e.length) sawEnemy = true;
      if (m.b.length) sawBullet = true;
      if (sawEnemy && sawBullet && snaps > 60) {
        const me = m.p.find(p => p[0] === aId);
        if (Math.abs(me[1] - 240) > 2 || Math.abs(me[2] - 600) > 2) fail('player did not move to reported position');
        console.log(`PASS: ${snaps} snapshots, wave ${m.w}, enemies ${m.e.length}, bullets ${m.b.length}`);
        clearTimeout(timer); srv.kill(); process.exit(0);
      }
    }
  });
}, 600);
