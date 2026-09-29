/*
 * server.js —— 局域网台球(黑八)服务端
 * 零依赖:静态文件 + 原生 WebSocket(wslib)+ 服务端权威物理与规则
 * 运行:node server.js   (PORT 环境变量可改端口,默认 3000)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const wslib = require('./wslib');
const P = require('./physics');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PUBLIC = path.join(__dirname, 'public');
let nextCid = 1;
const kickedNames = new Set(); // 被管理员移出的昵称,本服务运行期间禁止再加入

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { p = '/'; }
  if (p === '/') p = '/index.html';
  // physics.js 位于项目根目录(服务端也要 require 它)
  const file = path.normalize(p === '/physics.js' ? path.join(__dirname, 'physics.js') : path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) && !file.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ---------------- 房间状态 ---------------- */
const state = {
  phase: 'lobby',          // lobby | placing | aiming | sim | over
  balls: P.rack(),
  players: [null, null],   // { name, conn } —— 0/1 号位
  spectators: new Set(),
  turn: 0,
  groups: [null, null],    // 'solid'(全色) | 'stripe'(花色)
  open: true,              // 台面是否未分色
  isBreak: true,
  breaker: 0,
  winner: null,
  reason: '',
  aim: { a: 0, p: 0, pulling: false, off: [0, 0] },
  shot: null,              // 进行中的一杆 {shooter,isBreak,firstHit,potted[],cuePotted,clearedBefore,startedAt}
  rematch: [false, false],
};

const conns = new Set();
let aimDirty = false, lastAimSent = 0;

const r2 = n => Math.round(n * 100) / 100;
const clamp = (v, a, b) => (v = +v, isFinite(v) ? Math.max(a, Math.min(b, v)) : a);
const clamp01 = n => (n = +n, isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const clampAngle = a => { a = +a; return isFinite(a) ? a : 0; };
const nameOf = i => (state.players[i] ? state.players[i].name : '玩家' + (i + 1));

function broadcast(obj, except) {
  const s = JSON.stringify(obj);
  for (const c of conns) {
    if (c !== except && c.open) c.send(s);
  }
}
function toast(text, except) { broadcast({ t: 'msg', text }, except); }

function roomMsg() {
  return {
    t: 'room',
    phase: state.phase,
    balls: state.balls.map(b => [b.id, r2(b.x), r2(b.y), b.potted ? 1 : 0]),
    turn: state.turn,
    groups: state.groups,
    open: state.open,
    isBreak: state.isBreak,
    breaker: state.breaker,
    winner: state.winner,
    reason: state.reason,
    players: state.players.map((p, i) => (p ? { name: p.name, online: !!(p.conn && p.conn.open), admin: !!p.admin } : null)),
    specs: Array.from(state.spectators).map(c => ({ cid: c.cid, name: c.name, admin: !!c.admin })),
    specCount: state.spectators.size,
    aim: (state.phase === 'aiming')
      ? { seat: state.turn, a: r2(state.aim.a), p: r2(state.aim.p), pulling: state.aim.pulling,
          off: state.aim.off || [0, 0] }
      : null,
  };
}
function broadcastRoom(except) { broadcast(roomMsg(), except); }

function resetRack() {
  state.balls = P.rack();
  state.phase = 'aiming';
  state.turn = state.breaker;
  state.groups = [null, null];
  state.open = true;
  state.isBreak = true;
  state.winner = null;
  state.reason = '';
  state.shot = null;
  state.aim = { a: 0, p: 0, pulling: false, off: [0, 0] };
  state.rematch = [false, false];
}

/* ---------------- 一杆结束:规则判定 ---------------- */
function finishShot(shot) {
  const shooter = shot.shooter, opp = 1 - shooter;
  const pottedNums = shot.potted;                 // 对象球,按落袋顺序
  const potted8 = pottedNums.indexOf(8) !== -1;
  const msgs = [];

  // 犯规判定
  let foul = false, foulReason = '';
  if (shot.cuePotted) { foul = true; foulReason = '白球落袋'; }
  else if (shot.firstHit === null) { foul = true; foulReason = '未击中任何球'; }
  else if (state.open && shot.firstHit === 8) { foul = true; foulReason = '首碰黑八'; }
  else if (!state.open && state.groups[shooter]) {
    const own = state.groups[shooter];
    const ok = P.ballType(shot.firstHit) === own || (shot.clearedBefore && shot.firstHit === 8);
    if (!ok) { foul = true; foulReason = '首碰不是本方球'; }
  }

  // 提前结算黑八(开球除外)
  if (!shot.isBreak && potted8) {
    const legal = !state.open && state.groups[shooter] && shot.clearedBefore && !foul;
    if (legal) return endGame(shooter, '合法击落黑八');
    return endGame(opp, foul ? `${nameOf(shooter)} 击落黑八时犯规` : `${nameOf(shooter)} 提前击落黑八`);
  }

  if (shot.isBreak) {
    state.isBreak = false;
    if (potted8) {
      P.respot(state.balls, 8);
      msgs.push('开球黑八落袋,重新放回置球点');
    }
    if (foul) {
      msgs.push(`犯规:${foulReason},${nameOf(opp)} 获得自由球`);
      giveBallInHand(opp);
    } else if (pottedNums.length > 0) {
      msgs.push(`${nameOf(shooter)} 开球进球,继续击球`);
      state.turn = shooter;
      state.phase = 'aiming';
    } else {
      state.turn = opp;
      state.phase = 'aiming';
    }
  } else {
    // 分色(开放台面 + 无犯规 + 打进非 8 球)
    if (state.open && !foul) {
      const first = pottedNums.find(n => n !== 8);
      if (first != null) {
        const t = P.ballType(first);
        state.groups[shooter] = t;
        state.groups[opp] = t === 'solid' ? 'stripe' : 'solid';
        state.open = false;
        msgs.push(`分色:${nameOf(shooter)} 打${t === 'solid' ? '全色(1-7)' : '花色(9-15)'},${nameOf(opp)} 打${t === 'solid' ? '花色(9-15)' : '全色(1-7)'}`);
      }
    }
    if (foul) {
      msgs.push(`犯规:${foulReason},${nameOf(opp)} 获得自由球`);
      giveBallInHand(opp);
    } else {
      const g = state.groups[shooter];
      const pottedOwn = pottedNums.some(n => g && P.ballType(n) === g);
      if (pottedOwn) {
        msgs.push(`${nameOf(shooter)} 进球,继续击球`);
        state.phase = 'aiming';
      } else {
        state.turn = opp;
        state.phase = 'aiming';
      }
    }
  }

  for (const m of msgs) toast(m);
  broadcastRoom();

  function endGame(winner, reason) {
    state.phase = 'over';
    state.winner = winner;
    state.reason = reason;
    state.shot = null;
    msgs.push(`🏆 ${nameOf(winner)} 获胜:${reason}`);
    for (const m of msgs) toast(m);
    broadcastRoom();
  }
}

function giveBallInHand(seat) {
  const cue = state.balls[0];
  cue.potted = true; cue.vx = 0; cue.vy = 0;
  state.turn = seat;
  state.phase = 'placing';
}

function startShot(a, p, off) {
  const shooter = state.turn;
  const g = state.groups[shooter];
  state.shot = {
    shooter,
    isBreak: state.isBreak,
    firstHit: null,
    potted: [],
    cuePotted: false,
    clearedBefore: g ? P.groupCleared(state.balls, g) : false,
    startedAt: Date.now(),
  };
  const cue = state.balls[0];
  P.strike(cue, a, p, off ? off[0] : 0, off ? off[1] : 0);
  state.phase = 'sim';
  state.aim = { a, p, pulling: false, off: off || [0, 0] };
  broadcast({ t: 'cuestrike', x: r2(cue.x), y: r2(cue.y), a: r2(a), p: r2(p) });
  broadcastRoom();
}

/* ---------------- 物理主循环(60Hz) ---------------- */
setInterval(() => {
  const now = Date.now();
  if (state.phase === 'sim' && state.shot) {
    const ev = P.step(state.balls, 1 / 60);
    for (const e of ev) {
      if (e.k === 'hit' && state.shot.firstHit === null && (e.a === 0 || e.b === 0)) {
        state.shot.firstHit = e.a === 0 ? e.b : e.a;
      } else if (e.k === 'pot') {
        if (e.id === 0) state.shot.cuePotted = true;
        else state.shot.potted.push(e.id);
      }
    }
    const sounds = ev
      .filter(e => e.k === 'hit' || e.k === 'rail' || e.k === 'pot')
      .slice(0, 8)
      .map(e => [e.k, r2(e.x), r2(e.y), Math.min(1, (e.sp || 0) / 900)]);
    const done = P.allStopped(state.balls) || now - state.shot.startedAt > 15000;
    if (done) for (const b of state.balls) if (!b.potted) { b.vx = 0; b.vy = 0; }
    const frame = { t: 'f', b: [], ev: sounds };
    if (done) frame.done = true;
    for (const b of state.balls) if (!b.potted) frame.b.push([b.id, r2(b.x), r2(b.y)]);
    broadcast(frame);
    if (done) {
      const shot = state.shot;
      state.shot = null;
      finishShot(shot);
    }
  }
  // 瞄准信息节流广播
  if (aimDirty && now - lastAimSent > 45) {
    aimDirty = false;
    lastAimSent = now;
    broadcast({ t: 'aim', seat: state.turn, a: r2(state.aim.a), p: r2(state.aim.p), pulling: state.aim.pulling,
                off: state.aim.off || [0, 0] });
  }
}, 16);

/* 心跳:清理死连接 */
setInterval(() => {
  for (const c of conns) {
    if (!c.open) { conns.delete(c); continue; }
    if (!c.alive) { c.close(); continue; }
    c.alive = false;
    c.ping();
  }
}, 25000);

/* ---------------- 连接与消息 ---------------- */
function onConnection(conn, req) {
  if (conns.size >= 16) { conn.close(); return; }
  conns.add(conn);
  conn.seat = null;
  conn.name = '';
  conn.cid = nextCid++;
  conn.admin = false;
  conn.helloed = false;
  conn.testAllowed = /[?&]test=1/.test(req.url || '');

  conn.onmessage = raw => {
    conn.alive = true;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    handleMessage(conn, m);
  };
  conn.onclose = () => {
    conns.delete(conn);
    if (conn.seat !== null && state.players[conn.seat] && state.players[conn.seat].conn === conn) {
      const leaver = conn.name || nameOf(conn.seat);
      state.players[conn.seat] = null;
      if (state.phase !== 'lobby') {
        state.phase = 'lobby';
        state.shot = null;
        state.balls = P.rack();
        state.groups = [null, null];
        state.open = true;
        state.isBreak = true;
        state.winner = null;
        state.reason = '';
        toast(`⚠ ${leaver} 离开,本局结束,等待玩家重新加入`);
      } else {
        toast(`${leaver} 离开了房间`);
      }
      broadcastRoom();
    } else if (state.spectators.delete(conn)) {
      broadcast({ t: 'spec', n: state.spectators.size });
    }
  };
}

function seatNameTaken(name) {
  return state.players.some(p => p && p.name === name);
}

function handleHello(conn, rawName, adminPass) {
  if (conn.helloed) return;
  conn.helloed = true;
  let name = String(rawName == null ? '' : rawName).trim().slice(0, 12);
  if (!name) name = '玩家';
  const wantAdmin = typeof adminPass === 'string' && adminPass.length > 0;
  conn.admin = wantAdmin && adminPass === ADMIN_PASSWORD;
  if (wantAdmin && !conn.admin) {
    conn.send(JSON.stringify({ t: 'msg', text: '管理员密码错误,已按普通玩家加入' }));
  }
  if (kickedNames.has(name)) {
    conn.send(JSON.stringify({ t: 'kicked', text: '该昵称已被管理员移出房间,请更换昵称后再加入' }));
    conn.close();
    return;
  }
  if (seatNameTaken(name)) {
    let i = 2;
    while (seatNameTaken(name + i)) i++;
    name = name + i;
  }
  conn.name = name;
  const seat = state.players.findIndex(p => p === null);
  if (seat === -1) {
    // 观战
    conn.seat = null;
    state.spectators.add(conn);
    const rm = roomMsg();
    rm.t = 'welcome';
    rm.you = { seat: null, name, role: conn.admin ? 'admin' : 'spectator' };
    conn.send(JSON.stringify(rm));
    broadcast({ t: 'spec', n: state.spectators.size }, conn);
    if (state.phase !== 'lobby' && state.phase !== 'over') {
      conn.send(JSON.stringify({ t: 'msg', text: '对局进行中,你已进入观战模式' }));
    }
  } else {
    conn.seat = seat;
    state.players[seat] = { name, conn, admin: conn.admin };
    const rm = roomMsg();
    rm.t = 'welcome';
    rm.you = { seat, name, role: conn.admin ? 'admin' : 'player' };
    conn.send(JSON.stringify(rm));
    broadcastRoom(conn);
    if (state.players[0] && state.players[1] && state.phase === 'lobby') {
      resetRack();
      toast(`游戏开始!${nameOf(state.breaker)} 先开球`);
      broadcastRoom();
    } else if (state.players[0] && state.players[1] && state.phase === 'over') {
      toast(`${name} 已入座,可点击"再来一局"开始`);
    }
  }
}

function handleMessage(conn, m) {
  switch (m.t) {
    case 'hello':
      handleHello(conn, m.name, m.adminPass);
      return;
    case 'admin':
      if (conn.admin) handleAdmin(conn, m);
      else conn.send(JSON.stringify({ t: 'msg', text: '该操作需要管理员权限' }));
      return;
    case 'aim':
      if (conn.seat !== null && state.phase === 'aiming' && state.turn === conn.seat) {
        state.aim.a = clampAngle(m.a);
        state.aim.p = clamp01(m.p);
        state.aim.pulling = !!m.pulling;
        if (Array.isArray(m.off) && m.off.length === 2 && isFinite(m.off[0]) && isFinite(m.off[1])) {
          state.aim.off = [clamp(m.off[0], -0.55, 0.55), clamp(m.off[1], -0.55, 0.55)];
        }
        aimDirty = true;
      }
      return;
    case 'shoot': {
      const p = clamp01(m.p);
      if (conn.seat !== null && state.phase === 'aiming' && state.turn === conn.seat && p >= 0.04) {
        let off = [0, 0];
        if (Array.isArray(m.off) && m.off.length === 2 && isFinite(m.off[0]) && isFinite(m.off[1])) {
          off = [clamp(m.off[0], -0.55, 0.55), clamp(m.off[1], -0.55, 0.55)];
          if (Math.hypot(off[0], off[1]) > 0.55) off = [0, 0]; // 击球点不得滑杆出球面
        }
        startShot(clampAngle(m.a), p, off);
      }
      return;
    }
    case 'place': {
      const x = +m.x, y = +m.y;
      if (conn.seat !== null && state.phase === 'placing' && state.turn === conn.seat &&
          isFinite(x) && isFinite(y) && P.validPlace(state.balls, x, y)) {
        const cue = state.balls[0];
        cue.x = x; cue.y = y; cue.potted = false; cue.vx = 0; cue.vy = 0; cue.wx = 0; cue.wy = 0;
        state.phase = 'aiming';
        broadcastRoom();
      }
      return;
    }
    case 'rematch':
      if (conn.seat !== null && state.phase === 'over') {
        if (!state.rematch[conn.seat]) {
          state.rematch[conn.seat] = true;
          if (state.rematch[0] && state.rematch[1]) {
            state.breaker = 1 - state.breaker;
            resetRack();
            toast(`新的一局,${nameOf(state.breaker)} 开球`);
            broadcastRoom();
          } else {
            toast(`${conn.name} 想再来一局,等待对方同意…`);
          }
        }
      }
      return;
    case 'test':
      if (conn.testAllowed) handleTest(m);
      return;
  }
}

/* ---------------- 管理员操作 ---------------- */
function handleAdmin(conn, m) {
  if (m.cmd === 'reset') {
    if (state.players[0] && state.players[1]) {
      if (state.phase !== 'lobby') state.breaker = 1 - state.breaker;
      resetRack();
      toast('👑 管理员重开了对局');
      broadcastRoom();
    } else {
      conn.send(JSON.stringify({ t: 'msg', text: '需要两名玩家入座才能开局' }));
    }
  } else if (m.cmd === 'kick') {
    let victim = null, label = '';
    if (typeof m.seat === 'number' && state.players[m.seat]) {
      victim = state.players[m.seat].conn;
      label = state.players[m.seat].name;
    } else if (typeof m.cid === 'number') {
      for (const c of state.spectators) {
        if (c.cid === m.cid) { victim = c; label = c.name; break; }
      }
    }
    if (!victim) { conn.send(JSON.stringify({ t: 'msg', text: '对方已不在房间' })); return; }
    if (victim === conn) { conn.send(JSON.stringify({ t: 'msg', text: '不能移出自己' })); return; }
    kickedNames.add(label);
    try { victim.send(JSON.stringify({ t: 'kicked', text: '你已被管理员移出房间' })); } catch (e) {}
    victim.close();
    toast(`👑 ${label} 已被管理员请出房间`);
  }
}

function handleTest(m) {
  if (m.cmd === 'set' && Array.isArray(m.balls)) {
    for (const it of m.balls) {
      if (!Array.isArray(it)) continue;
      const b = state.balls.find(b => b.id === it[0]);
      if (b) {
        b.x = +it[1]; b.y = +it[2];
        b.potted = !!it[3];
        if (b.potted) { b.vx = 0; b.vy = 0; }
      }
    }
    broadcastRoom();
  } else if (m.cmd === 'setg' && Array.isArray(m.groups)) {
    state.groups = [m.groups[0] || null, m.groups[1] || null];
    state.open = m.open !== false && (state.groups[0] === null);
    broadcastRoom();
  }
}

/* ---------------- LAN 信息 ---------------- */
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const it of ifs[k] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  if (p === '/laninfo') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ port: PORT, ips: lanIPs() }));
    return;
  }
  serveStatic(req, res);
});
wslib.attach(server, onConnection);

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('');
  console.log('  🎱  局域网台球(黑八)已启动');
  console.log('  ────────────────────────────────');
  console.log(`  本机:    http://127.0.0.1:${PORT}`);
  for (const ip of ips) console.log(`  局域网:  http://${ip}:${PORT}`);
  console.log('');
  console.log('  其他设备请用"局域网"地址访问。');
  console.log('  若无法访问,请在 Windows 防火墙中放行 Node.js(或该端口)。');
  console.log(`  👑 管理员密码: ${ADMIN_PASSWORD}   (可用环境变量 ADMIN_PASSWORD 修改)`);
  console.log('');
});
