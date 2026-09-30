/*
 * client.js —— 局域网台球(黑八)客户端
 * 渲染 / 输入 / 音效 / 联机协议。物理全部由服务端权威计算,本文件只做表现。
 */
(() => {
'use strict';

const B = window.Billiards;
const W = B.W, H = B.H, R = B.R;
const M = 46; // 木框宽度(世界单位)

const COLORS = {
  1: '#f2b820', 2: '#1f5fbf', 3: '#d7263d', 4: '#6b2fa0', 5: '#f2711c',
  6: '#1a9e5c', 7: '#8c2f39', 8: '#141414',
  9: '#f2b820', 10: '#1f5fbf', 11: '#d7263d', 12: '#6b2fa0', 13: '#f2711c',
  14: '#1a9e5c', 15: '#8c2f39',
};

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ================= 音效(真实采样 + WebAudio,合成兜底) ================= */
const SFX = (() => {
  let ac = null, master = null;
  let muted = localStorage.getItem('pool_mute') === '1';
  let loadStarted = false;
  const buffers = {};   // name → AudioBuffer(已截取首击并归一化)
  const last = {};

  function ensure() {
    try {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.9;
        master.connect(ac.destination);
        startLoad();
      }
      if (ac.state === 'suspended') ac.resume();
      return true;
    } catch (e) { return false; }
  }

  function out(pan) {
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pan || 0, -1, 1);
      p.connect(master);
      return p;
    }
    return master;
  }

  /* ---- 采样加载:截取录音中的第一声撞击(去静音/连击),峰值归一化,尾部淡出 ---- */
  function startLoad() {
    if (loadStarted) return;
    loadStarted = true;
    const files = [
      ['hit1', '/sounds/hit1.mp3', 0.14],    // billiard ball clack (Za-Games, CC0)
      ['hit2', '/sounds/hit2.mp3', 0.16],    // pool table ball hit (AmberdeMeillon, CC0)
      ['strike', '/sounds/strike.mp3', 0.09],// cue stick hits ball (craigsmith, CC0)
      ['pot', '/sounds/pot.mp3', 0.7],       // pool ball falling (Yarmonics, CC0)
      ['rail', '/sounds/rail.mp3', 0.22],    // bouncing ball 首次落地 (yfjesse, CC0)
    ];
    for (const [name, url, winSec] of files) {
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(url); return r.arrayBuffer(); })
        .then(ab => ac.decodeAudioData(ab))
        .then(buf => { buffers[name] = extractOnset(buf, winSec); })
        .catch(() => { /* 加载失败时走合成音兜底 */ });
    }
  }

  function extractOnset(buf, winSec) {
    try {
      const sr = buf.sampleRate;
      const ch0 = buf.getChannelData(0);
      let peak = 0;
      const stride = Math.max(1, Math.floor(ch0.length / 30000));
      for (let i = 0; i < ch0.length; i += stride) peak = Math.max(peak, Math.abs(ch0[i]));
      if (peak < 1e-4) return buf;
      let onset = 0;
      const th = peak * 0.15;
      for (let i = 0; i < ch0.length; i++) { if (Math.abs(ch0[i]) > th) { onset = i; break; } }
      const start = Math.max(0, onset - Math.floor(sr * 0.003));
      const len = Math.min(Math.floor(sr * winSec), ch0.length - start);
      if (len <= 0) return buf;
      const out2 = ac.createBuffer(Math.min(2, buf.numberOfChannels), len, sr);
      const norm = 0.85 / peak;
      const fade = Math.max(16, Math.floor(sr * 0.03));
      for (let c = 0; c < out2.numberOfChannels; c++) {
        const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
        const dst = out2.getChannelData(c);
        for (let i = 0; i < len; i++) {
          dst[i] = src[start + i] * norm;
          if (i > len - fade) dst[i] *= (len - i) / fade;
        }
      }
      return out2;
    } catch (e) { return buf; }
  }

  function playSample(name, vol, pan, rate) {
    const b = buffers[name];
    if (!b || !ensure() || muted || vol <= 0.01) return false;
    const src = ac.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = ac.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(out(pan));
    src.start();
    return true;
  }

  /* ---- 合成音:库边闷响 / 兜底 / 胜负旋律 ---- */
  function tone(freq, dur, vol, type, slide, pan) {
    if (!ensure() || muted || vol <= 0.01) return;
    const t = ac.currentTime;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(out(pan));
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, freq, pan) {
    if (!ensure() || muted || vol <= 0.01) return;
    const n = Math.max(16, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource(); src.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
    const g = ac.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(out(pan));
    src.start(ac.currentTime);
  }
  function gate(key, ms) {
    const now = performance.now();
    if (last[key] && now - last[key] < ms) return false;
    last[key] = now; return true;
  }

  return {
    hit(v, x) {
      if (!gate('hit', 22)) return;
      const pan = (x - W / 2) / W * 1.2;
      const vol = (0.12 + 0.88 * Math.min(1, v)) * 0.8;
      const rate = 0.92 + Math.random() * 0.16;
      if (!playSample(Math.random() < 0.5 ? 'hit1' : 'hit2', vol, pan, rate)) {
        if (gate('hitS', 28)) { tone(1400 + 900 * v, 0.045, 0.45 * v, 'triangle', -600, pan); noise(0.03, 0.3 * v, 2600, pan); }
      }
    },
    rail(v, x) {
      if (!gate('rail', 45)) return;
      const pan = (x - W / 2) / W * 1.2;
      const vol = (0.2 + 0.8 * Math.min(1, v)) * 0.7;
      const rate = 0.88 + Math.random() * 0.18;
      if (!playSample('rail', vol, pan, rate)) {
        tone(170, 0.08, 0.3 * Math.min(1, v), 'sine', -60, pan);
        noise(0.04, 0.1 * Math.min(1, v), 500, pan);
      }
    },
    pot(x, v) {
      if (!gate('pot', 50)) return;
      const pan = (x - W / 2) / W * 1.2;
      const vol = 0.3 + 0.7 * Math.min(1, (v || 0) / 1000);
      if (!playSample('pot', 0.85 * vol, pan, 0.95 + Math.random() * 0.1)) {
        tone(520, 0.17, 0.5 * vol, 'sine', -370, pan);
        noise(0.12, 0.28 * vol, 900, pan);
      }
    },
    strike(p) {
      if (!gate('strike', 90)) return;
      const vol = 0.35 + 0.65 * p;
      if (!playSample('strike', 0.8 * vol, 0, 0.9 + Math.random() * 0.15)) {
        tone(950, 0.05, 0.4 * vol, 'square', -420, 0);
        noise(0.03, 0.22, 3200, 0);
      }
    },
    win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.3, 0.32, 'triangle', 0, 0), i * 150)); },
    lose() { [420, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 0.32, 0.28, 'triangle', 0, 0), i * 170)); },
    toggle() { muted = !muted; localStorage.setItem('pool_mute', muted ? '1' : '0'); return muted; },
    get muted() { return muted; },
    ensure,
    debug() { return Object.keys(buffers).map(k => k + ':' + buffers[k].duration.toFixed(2) + 's'); },
  };
})();

// 提前建好音频上下文并预加载采样(挂起状态也能解码,首次交互自动恢复)
SFX.ensure();

/* ================= 全局状态 ================= */
const G = {
  ws: null,
  my: { seat: null, name: '', role: 'guest' },
  pendingAdminPass: '',
  room: null,
  balls: [],
  remoteAim: null,
  myAim: { a: 0, p: 0, off: [0, 0] },
  precisePower: 0.45,
  pull: { active: false, charge: false, dirx: 1, diry: 0, sx: 0, sy: 0, power: 0 },
  ghost: { show: false, x: 0, y: 0, valid: false },
  strikeFx: null,
  scale: 1, offX: 0, offY: 0, dpr: 1,
  overlayMode: null,
  overKey: null,
  requestedRematch: false,
  specCount: 0,
};
let rejoinTimer = null;
let kicked = false;
let adminPanelEl = null;

const canvas = $('cv');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');

/* ================= 联机 ================= */
function send(obj) { if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify(obj)); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams();
  if (/[?&]test=1/.test(location.search)) params.set('test', '1');
  if (new URLSearchParams(location.search).get('mode') === 'solo') params.set('mode', 'solo');
  const q = '?' + params.toString();
  let ws;
  try { ws = new WebSocket(proto + '://' + location.host + '/ws' + q); }
  catch (e) { setTimeout(connect, 1500); return; }
  G.ws = ws;
  ws.onopen = () => {
    if (G.my.name) { send({ t: 'hello', name: G.my.name, adminPass: G.pendingAdminPass || undefined }); } // 断线重连,自动回归
    else showJoin(localStorage.getItem('pool_name'));
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m && typeof m === 'object') handleMsg(m);
  };
  ws.onclose = () => {
    if (kicked || rejoinTimer) return;
    showReconnect();
    rejoinTimer = setTimeout(() => { rejoinTimer = null; connect(); }, 1500);
  };
  ws.onerror = () => {};
}

function handleMsg(m) {
  switch (m.t) {
    case 'welcome': {
      G.my.seat = m.you.seat;
      G.my.name = m.you.name;
      G.my.role = m.you.role || (m.you.seat !== null ? 'player' : 'spectator');
      if (G.my.role !== 'admin') G.pendingAdminPass = '';
      $('adminBtn').style.display = G.my.role === 'admin' ? '' : 'none';
      applyRoom(m);
      overlay.classList.remove('show');
      G.overlayMode = null;
      if (G.my.seat === null) showSpec();
      else if (m.phase === 'lobby' && !(m.players[0] && m.players[1])) showWaiting(G.my.seat);
      break;
    }
    case 'room': applyRoom(m); break;
    case 'f': applyFrame(m); break;
    case 'aim':
      if (m.seat !== G.my.seat) G.remoteAim = { seat: m.seat, a: m.a, p: m.p, pulling: m.pulling, off: m.off || [0, 0] };
      break;
    case 'msg':
      toast(m.text, /犯规|提前/.test(m.text) ? 'warn' : /获胜|分色|游戏开始|新的一局|管理员|请出/.test(m.text) ? 'gold' : '');
      break;
    case 'kicked': {
      kicked = true;
      localStorage.removeItem('pool_name');
      $('adminBtn').style.display = 'none';
      if (adminPanelEl) { adminPanelEl.remove(); adminPanelEl = null; }
      G.overlayMode = 'kicked';
      overlay.classList.add('show');
      overlay.innerHTML = `
        <div class="card">
          <h1>🚫 已被移出房间</h1>
          <div class="sub" id="kickReason"></div>
          <button class="btn ghost" id="kickBack">返回</button>
        </div>`;
      $('kickReason').textContent = m.text || '';
      $('kickBack').onclick = () => location.reload();
      break;
    }
    case 'cuestrike':
      SFX.strike(m.p);
      G.strikeFx = { t0: performance.now(), x: m.x, y: m.y, a: m.a, p: m.p };
      break;
    case 'spec':
      if (G.room) { G.room.specCount = m.n; updateRoomInfo(); }
      break;
  }
}

function applyRoom(m) {
  G.room = m;
  if (m.specCount != null) G.specCount = m.specCount;
  for (const it of m.balls) {
    const id = it[0], x = it[1], y = it[2], potted = !!it[3];
    let b = G.balls[id];
    if (!b) b = G.balls[id] = { id, x, y, rx: x, ry: y, potted, sink: 1, sinkT0: 0 };
    b.x = x; b.y = y;
    if (potted && !b.potted && !b.sinkT0) b.sinkT0 = performance.now() - 90;
    if (!potted && b.potted) { b.sinkT0 = 0; b.sink = 1; }
    b.potted = potted;
  }
  if (m.aim && (G.my.seat === null || m.aim.seat !== G.my.seat)) G.remoteAim = m.aim;
  updateRoomInfo();
  updateHud();

  if (m.phase === 'over') {
    const key = m.winner + '|' + m.reason;
    if (G.overKey !== key) {
      G.overKey = key;
      showOver(m);
      if (G.my.seat !== null) { if (G.my.seat === m.winner) SFX.win(); else SFX.lose(); }
    }
  } else {
    if (G.overKey) { G.overKey = null; hideOver(); G.requestedRematch = false; }
    if (G.overlayMode === 'waiting' && m.players[0] && m.players[1]) {
      overlay.classList.remove('show');
      G.overlayMode = null;
    }
  }
  canvas.classList.toggle('placing', m.phase === 'placing' && G.my.seat !== null && m.turn === G.my.seat);
  $('tipWidget').classList.toggle('active', m.phase === 'aiming' && G.my.seat !== null && m.turn === G.my.seat);
  $('precisionControls').disabled = !myTurnAiming();
  if (adminPanelEl) renderAdminPanel();
}

function applyFrame(m) {
  const seen = new Set();
  for (const it of m.b) {
    const b = G.balls[it[0]];
    if (b) { b.x = it[1]; b.y = it[2]; seen.add(it[0]); }
  }
  const now = performance.now();
  for (const b of G.balls) {
    if (b && !b.potted && !seen.has(b.id) && b.id !== 0) { b.potted = true; b.sinkT0 = now; }
  }
  if (m.ev) for (const [k, x, y, v] of m.ev) {
    if (k === 'hit') SFX.hit(v, x);
    else if (k === 'rail') SFX.rail(v, x);
    else if (k === 'pot') SFX.pot(x, v);
  }
}

/* ---- 击球点控件(高低杆 / 左右塞) ---- */
let tipDrag = false;
function updateTipDot() {
  const ball = $('tipBall');
  const dot = $('tipDot');
  if (!ball || !dot) return;
  const [a, b] = G.myAim.off;
  const max = ball.clientWidth / 2 - 6;
  dot.style.left = `calc(50% + ${(a / 0.55) * max}px)`;
  dot.style.top = `calc(50% + ${(-b / 0.55) * max}px)`;
  $('sideSpin').value = Math.round(a * 100);
  $('topSpin').value = Math.round(b * 100);
  $('sideValue').textContent = Math.round(a * 100) + '%';
  $('topValue').textContent = Math.round(b * 100) + '%';
}
function setTipFromEvent(e) {
  const ball = $('tipBall');
  const r = ball.getBoundingClientRect();
  const k = (r.width / 2 - 5) / 0.55;
  let a = (e.clientX - (r.left + r.width / 2)) / k;
  let b = -(e.clientY - (r.top + r.height / 2)) / k;
  const L = Math.hypot(a, b);
  if (L > 0.55) { a *= 0.55 / L; b *= 0.55 / L; }
  G.myAim.off = [a, b];
  updateTipDot();
  sendAim(true);
}

/* ================= HUD / 弹层 ================= */
function miniBall(n, out) {
  const s = document.createElement('span');
  s.className = 'mini' + (n > 8 ? ' stripe' : '') + (out ? ' out' : '');
  if (n <= 8) s.style.background = COLORS[n];
  else s.style.setProperty('--c', COLORS[n]);
  const t = document.createElement('span');
  t.textContent = n;
  s.appendChild(t);
  return s;
}

function updateHud() {
  const r = G.room;
  if (!r) return;
  for (let i = 0; i < 2; i++) {
    const p = r.players[i];
    $('name' + i).textContent = p ? p.name : '空位';
    $('card' + i).classList.toggle('active', r.turn === i && (r.phase === 'aiming' || r.phase === 'placing' || r.phase === 'sim'));
    const tag = $('tag' + i);
    if (p && (G.my.seat === i || p.admin)) {
      tag.textContent = (G.my.seat === i ? '你' : '') + (p.admin ? '👑' : '');
      tag.classList.add('show');
    } else tag.classList.remove('show');
    const gEl = $('group' + i), bEl = $('balls' + i);
    bEl.textContent = '';
    const g = r.groups[i];
    if (g) {
      const nums = g === 'solid' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
      const cleared = nums.every(n => G.balls[n] && G.balls[n].potted);
      gEl.textContent = cleared ? '目标:黑八' : (g === 'solid' ? '全色(1-7)' : '花色(9-15)');
      for (const n of nums) bEl.appendChild(miniBall(n, G.balls[n] && G.balls[n].potted));
      if (cleared) bEl.appendChild(miniBall(8, G.balls[8] && G.balls[8].potted));
    } else if (p) {
      gEl.textContent = r.open ? '待分色 · 开放台面' : '—';
    } else {
      gEl.textContent = '等待加入';
    }
  }
  updateStatus();
}

function updateRoomInfo() {
  const r = G.room, el = $('roomInfo');
  if (!r) { el.textContent = '正在连接…'; return; }
  el.textContent = '';
  const p0 = r.players[0], p1 = r.players[1];
  if (p0 && p1) {
    const b0 = document.createElement('b'); b0.textContent = p0.name;
    const b1 = document.createElement('b'); b1.textContent = p1.name;
    const vs = document.createElement('span'); vs.className = 'vs'; vs.textContent = '⚔';
    el.appendChild(b0); el.appendChild(vs); el.appendChild(b1);
  } else if (p0 || p1) {
    const b = document.createElement('b'); b.textContent = (p0 || p1).name;
    el.appendChild(b);
    el.appendChild(document.createTextNode(' 等待对手加入…'));
  } else {
    el.textContent = '等待玩家加入…';
  }
  const spec = r.specCount != null ? r.specCount : G.specCount;
  if (r.mode === 'solo') el.appendChild(document.createTextNode(' · 人机对战'));
  if (spec > 0) el.appendChild(document.createTextNode(` · 👁 ${spec}`));
}

function updateStatus() {
  const r = G.room;
  if (!r) return;
  const el = $('statusLine');
  const myTurn = G.my.seat !== null && r.turn === G.my.seat;
  let txt = '', dim = false;
  switch (r.phase) {
    case 'lobby':
      txt = (r.players[0] && r.players[1]) ? '准备开始…' : '等待对手加入…'; dim = true; break;
    case 'placing':
      txt = myTurn ? '自由球:移动鼠标选择位置,点击放置白球' : '对方获得自由球,正在放置白球…'; dim = !myTurn; break;
    case 'aiming': {
      if (myTurn) txt = '你的回合:移动瞄准 · 按住向后拖拽蓄力 · 松手击球';
      else {
        const shooter = r.players[r.turn];
        txt = G.my.seat === null && shooter ? `${shooter.name} 瞄准中…` : '对方瞄准中…';
        dim = true;
      }
      break;
    }
    case 'sim':
      txt = '击球中…'; dim = true; break;
    case 'over':
      txt = r.winner != null && r.players[r.winner] ? `🏆 ${r.players[r.winner].name} 获胜` : '本局结束'; break;
  }
  if (el.textContent !== txt) { el.textContent = txt; el.classList.toggle('dim', dim); }
  const p = G.pull.active ? G.pull.power : 0;
  $('powerFill').style.width = (p * 100).toFixed(0) + '%';
  $('powerText').textContent = Math.round(p * 100) + '%';
}

function toast(text, cls) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (cls ? ' ' + cls : '');
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => el.classList.add('fade'), 2500);
  setTimeout(() => el.remove(), 3100);
}

function showJoin(prefill) {
  G.overlayMode = 'join';
  overlay.classList.add('show');
  overlay.innerHTML = `
    <div class="card">
      <h1>🎱 局域网台球</h1>
      <div class="sub">${new URLSearchParams(location.search).get('mode') === 'solo' ? '独立人机对局，电脑自动接招<br>无需等待其他玩家' : '同一局域网的设备打开本页即可加入<br>先到者坐 1 号位,后到者坐 2 号位,其余观战'}</div>
      <input type="text" id="joinName" maxlength="12" placeholder="输入你的昵称" autocomplete="off">
      <div class="admin-link" id="adminLink">管理员登录</div>
      <input type="password" id="adminPass" maxlength="24" placeholder="管理员密码" autocomplete="off" style="display:none">
      <br>
      <button class="btn" id="joinBtn">${new URLSearchParams(location.search).get('mode') === 'solo' ? '开始人机对战' : '加入联机对局'}</button>
      <button class="btn ghost" id="modeBtn">${new URLSearchParams(location.search).get('mode') === 'solo' ? '切换到联机对战' : '单机 · 挑战电脑'}</button>
    </div>`;
  const inp = $('joinName');
  inp.value = prefill || '';
  $('modeBtn').onclick = () => {
    localStorage.setItem('pool_name', inp.value.trim().slice(0, 12));
    location.href = new URLSearchParams(location.search).get('mode') === 'solo' ? '/' : '/?mode=solo';
  };
  $('adminLink').onclick = () => {
    const p = $('adminPass');
    const show = p.style.display === 'none';
    p.style.display = show ? 'block' : 'none';
    $('adminLink').textContent = show ? '收起管理员登录' : '管理员登录';
    if (show) p.focus();
  };
  const go = () => {
    const name = inp.value.trim().slice(0, 12) || '玩家';
    localStorage.setItem('pool_name', name);
    G.my.name = name;
    const ap = $('adminPass');
    const adminPass = ap && ap.style.display !== 'none' ? ap.value.trim() : '';
    G.pendingAdminPass = adminPass;
    SFX.ensure();
    send({ t: 'hello', name, adminPass: adminPass || undefined });
    $('joinBtn').disabled = true;
    $('joinBtn').textContent = '连接中…';
  };
  $('joinBtn').onclick = go;
  inp.onkeydown = e => { if (e.key === 'Enter') go(); };
  setTimeout(() => { inp.focus(); }, 60);
}

function showWaiting(mySeat) {
  G.overlayMode = 'waiting';
  overlay.classList.add('show');
  overlay.innerHTML = `
    <div class="card">
      <h1>等待对手…</h1>
      <div class="sub">你已就座:${mySeat === 0 ? '1 号位' : '2 号位'}。<br>把下面的地址发给同一局域网的朋友,浏览器打开即可加入。</div>
      <div class="linkbox" id="linkbox">正在获取局域网地址…</div>
      <span class="seat-badge"><span class="spin"></span>等待玩家加入</span>
      <button class="btn ghost" id="soloBtn">不等了，挑战电脑</button>
    </div>`;
  $('soloBtn').onclick = () => { location.href = '/?mode=solo'; };
  fetch('/laninfo').then(r => r.json()).then(info => {
    const box = $('linkbox');
    if (!box) return;
    box.textContent = '';
    const label = document.createElement('div');
    label.textContent = '点击地址即可复制:';
    box.appendChild(label);
    const urls = info.ips.map(ip => `http://${ip}:${info.port}`);
    urls.sort((a, b) => (b.includes('192.168.') ? 1 : 0) - (a.includes('192.168.') ? 1 : 0));
    for (const u of urls) {
      const row = document.createElement('div'); row.className = 'url';
      const code = document.createElement('code'); code.textContent = u;
      const btn = document.createElement('button'); btn.textContent = '复制';
      btn.onclick = () => {
        if (navigator.clipboard) navigator.clipboard.writeText(u).catch(() => {});
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      };
      row.appendChild(code); row.appendChild(btn);
      box.appendChild(row);
    }
  }).catch(() => {});
}

function showSpec() {
  G.overlayMode = 'spec';
  overlay.classList.add('show');
  overlay.innerHTML = `
    <div class="card">
      <h1>👀 观战模式</h1>
      <div class="sub">座位已满,你将以观众身份观看对局。<br>玩家离开后空出的座位,刷新页面即可尝试加入。</div>
      <button class="btn ghost" id="specOk">开始观看</button>
    </div>`;
  $('specOk').onclick = () => { overlay.classList.remove('show'); G.overlayMode = null; };
}

/* ---------- 管理员面板 ---------- */
function toggleAdminPanel() {
  if (adminPanelEl) { adminPanelEl.remove(); adminPanelEl = null; return; }
  adminPanelEl = document.createElement('div');
  adminPanelEl.className = 'admin-panel';
  document.body.appendChild(adminPanelEl);
  renderAdminPanel();
}

function renderAdminPanel() {
  if (!adminPanelEl) return;
  const r = G.room;
  adminPanelEl.textContent = '';
  if (!r) return;
  const head = document.createElement('div');
  head.className = 'ap-head';
  const t = document.createElement('span');
  t.textContent = '👑 对局管理';
  const x = document.createElement('button');
  x.textContent = '×';
  x.onclick = toggleAdminPanel;
  head.appendChild(t);
  head.appendChild(x);
  adminPanelEl.appendChild(head);

  const reset = document.createElement('button');
  reset.className = 'ap-reset';
  reset.textContent = '重开一局';
  reset.onclick = () => send({ t: 'admin', cmd: 'reset' });
  adminPanelEl.appendChild(reset);

  const mkRow = (label, kickFn, isAdmin) => {
    const row = document.createElement('div');
    row.className = 'ap-row';
    const n = document.createElement('span');
    n.className = 'ap-name';
    n.textContent = label + (isAdmin ? ' 👑' : '');
    const k = document.createElement('button');
    k.className = 'ap-kick';
    k.textContent = '踢出';
    if (!kickFn) k.disabled = true;
    else k.onclick = kickFn;
    row.appendChild(n);
    row.appendChild(k);
    return row;
  };
  for (let i = 0; i < 2; i++) {
    const p = r.players[i];
    adminPanelEl.appendChild(mkRow(
      p ? p.name : '(空位)',
      p ? () => send({ t: 'admin', cmd: 'kick', seat: i }) : null,
      p && p.admin,
    ));
  }
  const specTitle = document.createElement('div');
  specTitle.className = 'ap-sec';
  specTitle.textContent = `观战 (${(r.specs || []).length})`;
  adminPanelEl.appendChild(specTitle);
  for (const s of (r.specs || [])) {
    adminPanelEl.appendChild(mkRow(s.name, () => send({ t: 'admin', cmd: 'kick', cid: s.cid }), s.admin));
  }
  if (!r.specs || r.specs.length === 0) {
    const none = document.createElement('div');
    none.className = 'ap-none';
    none.textContent = '暂无观战';
    adminPanelEl.appendChild(none);
  }
  const hint = document.createElement('div');
  hint.className = 'ap-none';
  hint.textContent = '被踢出的昵称需更换后才能再加入';
  adminPanelEl.appendChild(hint);
}

function showReconnect() {
  if (G.overlayMode !== 'reconnect') {
    G.overlayMode = 'reconnect';
    overlay.classList.add('show');
    overlay.innerHTML = `
      <div class="card">
        <h1>连接断开</h1>
        <div class="sub"><span class="spin"></span>正在重新连接服务器…</div>
      </div>`;
  }
}

function showOver(m) {
  const b = $('banner');
  const wname = m.winner != null && m.players[m.winner] ? m.players[m.winner].name : '?';
  b.classList.add('show');
  b.textContent = '';
  const inner = document.createElement('div');
  inner.className = 'inner';
  const t = document.createElement('div');
  t.className = 'win-title';
  t.textContent = `🏆 ${wname} 获胜`;
  const rs = document.createElement('div');
  rs.className = 'win-reason';
  rs.textContent = m.reason || '';
  inner.appendChild(t); inner.appendChild(rs);
  if (G.my.seat !== null) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.marginTop = '14px';
    btn.textContent = G.requestedRematch ? '等待对方同意…' : '再来一局';
    btn.disabled = G.requestedRematch;
    btn.onclick = () => {
      G.requestedRematch = true;
      send({ t: 'rematch' });
      btn.disabled = true;
      btn.textContent = '等待对方同意…';
    };
    inner.appendChild(btn);
  } else {
    const hint = document.createElement('div');
    hint.className = 'win-reason';
    hint.style.marginTop = '10px';
    hint.textContent = '等待玩家开始下一局…';
    inner.appendChild(hint);
  }
  b.appendChild(inner);
}
function hideOver() {
  const b = $('banner');
  b.classList.remove('show');
  b.textContent = '';
}

/* ================= 画布与渲染 ================= */
let tableCache = document.createElement('canvas');

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function resize() {
  const stage = $('stage');
  const availW = Math.max(220, stage.clientWidth - 20);
  const availH = Math.max(160, stage.clientHeight - 20);
  const worldW = W + 2 * M, worldH = H + 2 * M;
  G.scale = Math.min(availW / worldW, availH / worldH);
  const cw = worldW * G.scale, ch = worldH * G.scale;
  G.dpr = window.devicePixelRatio || 1;
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = Math.round(cw * G.dpr);
  canvas.height = Math.round(ch * G.dpr);
  G.offX = M * G.scale;
  G.offY = M * G.scale;
  buildTable();
}
window.addEventListener('resize', resize);
$('precisionPanel').addEventListener('toggle', resize);

function buildTable() {
  tableCache.width = canvas.width;
  tableCache.height = canvas.height;
  const c = tableCache.getContext('2d');
  c.setTransform(G.dpr * G.scale, 0, 0, G.dpr * G.scale, G.offX * G.dpr, G.offY * G.dpr);

  // 木框
  const wood = c.createLinearGradient(-M, -M, W + M, H + M);
  wood.addColorStop(0, '#7d5a38');
  wood.addColorStop(0.5, '#5d3f26');
  wood.addColorStop(1, '#6d4a2c');
  rr(c, -M, -M, W + 2 * M, H + 2 * M, 24);
  c.fillStyle = wood; c.fill();
  c.lineWidth = 2; c.strokeStyle = 'rgba(0,0,0,0.45)'; c.stroke();
  rr(c, -M + 3, -M + 3, W + 2 * M - 6, H + 2 * M - 6, 21);
  c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,235,200,0.1)'; c.stroke();

  // 台呢
  const felt = c.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, W * 0.62);
  felt.addColorStop(0, '#32825a');
  felt.addColorStop(0.65, '#2a7050');
  felt.addColorStop(1, '#1f573d');
  c.fillStyle = felt;
  c.fillRect(0, 0, W, H);
  c.globalAlpha = 0.045;
  c.strokeStyle = '#000';
  c.lineWidth = 1;
  for (let y = 0; y < H; y += 7) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); c.stroke(); }
  c.globalAlpha = 1;

  // 库边
  c.fillStyle = '#245c42';
  c.fillRect(-9, -9, W + 18, 9);
  c.fillRect(-9, H, W + 18, 9);
  c.fillRect(-9, 0, 9, H);
  c.fillRect(W, 0, 9, H);
  c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1.5;
  c.strokeRect(0, 0, W, H);
  c.strokeStyle = 'rgba(255,255,255,0.07)'; c.lineWidth = 1;
  c.strokeRect(-8.5, -8.5, W + 17, H + 17);

  // 开球线 + 置球点
  c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(W * 0.25, 4); c.lineTo(W * 0.25, H - 4); c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.18)';
  for (const sx of [W * 0.25, W * 0.75]) { c.beginPath(); c.arc(sx, H / 2, 3, 0, 7); c.fill(); }

  // 星位点
  c.fillStyle = 'rgba(240,228,196,0.85)';
  for (const x of [1, 2, 3, 5, 6, 7].map(k => W * k / 8)) {
    for (const y of [-M / 2, H + M / 2]) { c.beginPath(); c.arc(x, y, 2.6, 0, 7); c.fill(); }
  }
  for (const y of [H * 0.25, H * 0.5, H * 0.75]) {
    for (const x of [-M / 2, W + M / 2]) { c.beginPath(); c.arc(x, y, 2.6, 0, 7); c.fill(); }
  }

  // 袋口
  for (const p of B.POCKETS) {
    const g = c.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.r);
    g.addColorStop(0, '#000');
    g.addColorStop(0.75, '#0a0d0b');
    g.addColorStop(1, '#18211b');
    c.beginPath(); c.arc(p.x, p.y, p.r, 0, 7);
    c.fillStyle = g; c.fill();
    c.lineWidth = 3; c.strokeStyle = 'rgba(25,16,8,0.9)'; c.stroke();
    c.lineWidth = 1.2; c.strokeStyle = 'rgba(255,235,200,0.12)';
    c.beginPath(); c.arc(p.x, p.y, p.r - 2.5, 0, 7); c.stroke();
  }
}

function drawBall(x, y, r, id) {
  if (r <= 0.5) return;
  if (id === 0) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.15, x, y, r * 1.25);
    g.addColorStop(0, '#fffdf6');
    g.addColorStop(0.55, '#efe9d8');
    g.addColorStop(1, '#c9c1ab');
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
    ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = 'rgba(196,60,60,0.7)';
    ctx.beginPath(); ctx.arc(x + r * 0.34, y + r * 0.12, r * 0.13, 0, 7); ctx.fill();
    return;
  }
  const col = COLORS[id] || '#888';
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.clip();
  if (id > 8) {
    ctx.fillStyle = '#f4efe2';
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.fillStyle = col;
    ctx.fillRect(x - r, y - r * 0.55, r * 2, r * 1.1);
  } else {
    ctx.fillStyle = col;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.1, x, y, r * 1.3);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.28, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.62, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
  ctx.beginPath(); ctx.arc(x, y, r * 0.46, 0, 7);
  ctx.fillStyle = '#f7f3e8'; ctx.fill();
  ctx.fillStyle = '#1c1c1c';
  ctx.font = `bold ${r * 0.62}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(id), x, y + r * 0.05);
}

let previewCache = { key: '', time: -Infinity, paths: [] };
function drawPrediction(src, now) {
  const power = G.pull.active ? G.pull.power : G.precisePower;
  const key = JSON.stringify([src.a, power, src.off, G.balls.filter(Boolean).map(b => [b.id, b.x, b.y, b.potted])]);
  if (key !== previewCache.key && now - previewCache.time >= 120) {
    previewCache = { key, time: now, paths: B.predict(G.balls, src.a, power, src.off || [0, 0]) };
  }
  // Do not show a stale prediction while controls are being adjusted.
  if (key !== previewCache.key) return;
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.lineWidth = 1.5;
  for (const path of previewCache.paths) {
    ctx.strokeStyle = path.id === 0 ? 'rgba(255,255,255,0.8)' : 'rgba(246,196,69,0.65)';
    ctx.beginPath();
    path.points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke();
  }
  ctx.restore();
}

function drawGuide(bx, by, a) {
  const dx = Math.cos(a), dy = Math.sin(a);
  let bestT = Infinity, hitBall = null;
  for (const b of G.balls) {
    if (!b || b.id === 0 || b.potted) continue;
    const ox = b.x - bx, oy = b.y - by;
    const proj = ox * dx + oy * dy;
    if (proj <= 0) continue;
    const perp2 = ox * ox + oy * oy - proj * proj;
    const rr2 = 4 * R * R;
    if (perp2 > rr2) continue;
    const t = proj - Math.sqrt(rr2 - perp2);
    if (t > 0 && t < bestT) { bestT = t; hitBall = b; }
  }
  let wallT = Infinity, wallAxis = null;
  if (dx < 0) { const t = (R - bx) / dx; if (t < wallT) { wallT = t; wallAxis = 'x'; } }
  if (dx > 0) { const t = (W - R - bx) / dx; if (t < wallT) { wallT = t; wallAxis = 'x'; } }
  if (dy < 0) { const t = (R - by) / dy; if (t < wallT) { wallT = t; wallAxis = 'y'; } }
  if (dy > 0) { const t = (H - R - by) / dy; if (t < wallT) { wallT = t; wallAxis = 'y'; } }
  let t = bestT, isBall = !!hitBall;
  if (!isBall && isFinite(wallT)) t = wallT;
  if (!isFinite(t)) return;
  const gx = bx + dx * t, gy = by + dy * t;

  ctx.setLineDash([6, 7]);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(bx + dx * (R + 2), by + dy * (R + 2));
  ctx.lineTo(gx, gy);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath(); ctx.arc(gx, gy, R, 0, 7);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.4; ctx.stroke();

  if (isBall) {
    const nx = (hitBall.x - gx) / (2 * R), ny = (hitBall.y - gy) / (2 * R);
    const ax2 = gx + nx * (R + 42), ay2 = gy + ny * (R + 42);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(gx + nx * R, gy + ny * R); ctx.lineTo(ax2, ay2); ctx.stroke();
    const ang = Math.atan2(ny, nx);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(ax2 + Math.cos(ang) * 7, ay2 + Math.sin(ang) * 7);
    ctx.lineTo(ax2 + Math.cos(ang + 2.5) * 7, ay2 + Math.sin(ang + 2.5) * 7);
    ctx.lineTo(ax2 + Math.cos(ang - 2.5) * 7, ay2 + Math.sin(ang - 2.5) * 7);
    ctx.closePath(); ctx.fill();
    const dot = dx * nx + dy * ny;
    let tx = dx - dot * nx, ty = dy - dot * ny;
    const tl = Math.hypot(tx, ty);
    if (tl > 0.18) {
      tx /= tl; ty /= tl;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + tx * 26, gy + ty * 26); ctx.stroke();
    }
  } else {
    let rx2 = dx, ry2 = dy;
    if (wallAxis === 'x') rx2 = -dx; else ry2 = -dy;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx + rx2 * 42, gy + ry2 * 42); ctx.stroke();
  }
}

function drawCue(x, y, a, power, alpha, offA) {
  const pull = 12 + power * 115;
  const L = 400, tip = R + 4 + pull;
  offA = offA || 0;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.translate(0, offA * R);   // 左右塞:球杆整体横向偏移
  // 杆影
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.moveTo(-tip, 4.5); ctx.lineTo(-tip - L, 7); ctx.lineTo(-tip - L, 11); ctx.lineTo(-tip, 6.5);
  ctx.closePath(); ctx.fill();
  // 杆身
  const grad = ctx.createLinearGradient(-tip, 0, -tip - L, 0);
  grad.addColorStop(0, '#e8c98f');
  grad.addColorStop(0.12, '#caa15e');
  grad.addColorStop(0.5, '#9a6a34');
  grad.addColorStop(1, '#5f3d1c');
  ctx.beginPath();
  ctx.moveTo(-tip - 12, -2.6); ctx.lineTo(-tip - L, -4.6); ctx.lineTo(-tip - L, 4.6); ctx.lineTo(-tip - 12, 2.6);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
  // 先角 + 皮头
  ctx.fillStyle = '#f3efe4';
  ctx.fillRect(-tip - 12, -2.5, 8.5, 5);
  ctx.fillStyle = '#3d7ec2';
  ctx.fillRect(-tip - 3.5, -2.3, 3.5, 4.6);
  ctx.restore();
}

function aimSource() {
  const r = G.room;
  if (!r || r.phase !== 'aiming') return null;
  if (G.my.seat !== null && r.turn === G.my.seat) {
    return { seat: G.my.seat, a: G.myAim.a, p: G.pull.active ? G.pull.power : 0, pulling: G.pull.active,
             off: G.myAim.off, mine: true };
  }
  if (G.remoteAim && G.remoteAim.seat === r.turn) {
    return { seat: G.remoteAim.seat, a: G.remoteAim.a, p: G.remoteAim.p, pulling: G.remoteAim.pulling,
             off: G.remoteAim.off || [0, 0], mine: false };
  }
  return null;
}

function draw(now) {
  const dpr = G.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tableCache, 0, 0);
  ctx.setTransform(dpr * G.scale, 0, 0, dpr * G.scale, G.offX * dpr, G.offY * dpr);

  // 位置插值 + 落袋动画
  for (const b of G.balls) {
    if (!b) continue;
    if (b.sinkT0) b.sink = Math.max(0, 1 - (now - b.sinkT0) / 180);
    const dx = b.x - b.rx, dy = b.y - b.ry;
    if (dx * dx + dy * dy > 1600) { b.rx = b.x; b.ry = b.y; }
    else { b.rx += dx * 0.55; b.ry += dy * 0.55; }
  }
  for (const b of G.balls) {
    if (!b) continue;
    const s = b.potted ? b.sink : 1;
    if (s <= 0) continue;
    ctx.globalAlpha = 0.26 * s;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(b.rx + 2.5, b.ry + 3.5, R * 0.95 * s, R * 0.8 * s, 0, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const b of G.balls) {
    if (!b) continue;
    const s = b.potted ? b.sink : 1;
    if (s <= 0) continue;
    drawBall(b.rx, b.ry, R * s, b.id);
  }

  // 瞄准 / 球杆
  const r = G.room;
  const cueBall = G.balls[0];
  const src = aimSource();
  if (r && r.phase === 'aiming' && src && cueBall && !cueBall.potted) {
    const offA = src.off ? src.off[0] : 0;
    if (src.mine) {
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(cueBall.rx, cueBall.ry, R + 4.5, 0, 7);
      ctx.strokeStyle = 'rgba(246,196,69,0.7)'; ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (src.mine && $('previewToggle').checked) drawPrediction(src, now);
    else drawGuide(cueBall.rx, cueBall.ry, src.a);
    drawCue(cueBall.rx, cueBall.ry, src.a, src.pulling ? src.p : 0, 1, offA);
    // 击球点标记(球杆皮头触碰位置)
    if (Math.abs(offA) > 0.02) {
      const px = cueBall.rx + offA * R * (-Math.sin(src.a));
      const py = cueBall.ry + offA * R * (Math.cos(src.a));
      ctx.beginPath(); ctx.arc(px, py, 2.2, 0, 7);
      ctx.fillStyle = '#3d7ec2'; ctx.fill();
    }
  }

  // 出杆动画
  if (G.strikeFx) {
    const t = (now - G.strikeFx.t0) / 1000;
    if (t > 0.26) G.strikeFx = null;
    else {
      const thrust = t < 0.09 ? 1 - t / 0.09 : 0;
      const alpha = t < 0.12 ? 1 : Math.max(0, 1 - (t - 0.12) / 0.14);
      drawCue(G.strikeFx.x, G.strikeFx.y, G.strikeFx.a, Math.max(0, thrust) * G.strikeFx.p, alpha);
    }
  }

  // 自由球 ghost
  if (r && r.phase === 'placing' && G.my.seat !== null && r.turn === G.my.seat && G.ghost.show) {
    const g = G.ghost;
    ctx.globalAlpha = 0.55;
    drawBall(g.x, g.y, R, 0);
    ctx.globalAlpha = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(g.x, g.y, R + 3, 0, 7);
    ctx.strokeStyle = g.valid ? 'rgba(255,255,255,0.85)' : 'rgba(255,90,90,0.9)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* ================= 输入 ================= */
function toWorld(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left - G.offX) / G.scale, y: (e.clientY - rect.top - G.offY) / G.scale };
}
function myTurnAiming() {
  const r = G.room;
  return !!(r && G.my.seat !== null && r.phase === 'aiming' && r.turn === G.my.seat);
}

canvas.addEventListener('pointerdown', e => {
  SFX.ensure();
  const r = G.room;
  if (!r) return;
  const w = toWorld(e);
  if (r.phase === 'placing' && G.my.seat !== null && r.turn === G.my.seat) {
    if (G.ghost.valid) send({ t: 'place', x: G.ghost.x, y: G.ghost.y });
    return;
  }
  if (!myTurnAiming()) return;
  const cue = G.balls[0];
  if (!cue || cue.potted) return;
  const a = $('aimLock').checked ? G.myAim.a : Math.atan2(w.y - cue.ry, w.x - cue.rx);
  G.myAim.a = a;
  G.pull.active = true;
  G.pull.charge = false;
  G.pull.dirx = Math.cos(a); G.pull.diry = Math.sin(a);
  G.pull.sx = w.x; G.pull.sy = w.y;
  G.pull.power = 0;
  canvas.classList.add('grabbing');
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  sendAim(true);
});

canvas.addEventListener('pointermove', e => {
  const r = G.room;
  if (!r) return;
  const w = toWorld(e);
  if (r.phase === 'placing' && G.my.seat !== null && r.turn === G.my.seat) {
    const x = clamp(w.x, R + 1, W - R - 1), y = clamp(w.y, R + 1, H - R - 1);
    G.ghost.show = true;
    G.ghost.x = x; G.ghost.y = y;
    G.ghost.valid = B.validPlace(G.balls, x, y);
    return;
  }
  if (!myTurnAiming()) return;
  const cue = G.balls[0];
  if (!cue || cue.potted) return;
  if (G.pull.active && !G.pull.charge) {
    G.pull.power = clamp(((G.pull.sx - w.x) * G.pull.dirx + (G.pull.sy - w.y) * G.pull.diry) / 260, 0, 1);
  } else if (!G.pull.active && !$('aimLock').checked) {
    G.myAim.a = Math.atan2(w.y - cue.ry, w.x - cue.rx);
  }
  sendAim();
});

function endPull(shoot) {
  if (!G.pull.active) return;
  G.pull.active = false;
  G.pull.charge = false;
  canvas.classList.remove('grabbing');
  const p = G.pull.power, a = G.myAim.a;
  if (shoot && p > 0.04) send({ t: 'shoot', a, p, off: G.myAim.off });
  sendAim(true);
}
canvas.addEventListener('pointerup', () => endPull(true));
canvas.addEventListener('pointercancel', () => endPull(false));
canvas.addEventListener('pointerleave', () => { if (!G.pull.active) G.ghost.show = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')) return;
  if (e.code === 'Space' && myTurnAiming() && !G.pull.active) {
    G.pull.active = true;
    G.pull.charge = true;
    G.pull.power = 0;
    sendAim(true);
    e.preventDefault();
    return;
  }
  if (!myTurnAiming()) return;
  if (e.key === 'ArrowLeft') { G.myAim.a -= e.shiftKey ? 0.02 : 0.004; sendAim(true); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { G.myAim.a += e.shiftKey ? 0.02 : 0.004; sendAim(true); e.preventDefault(); }
  else if (e.key === 'Escape') endPull(false);
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' && G.pull.active && G.pull.charge) endPull(true);
});
window.addEventListener('blur', () => endPull(false));

let lastAimSent = 0;
let lastSentAim = { a: 0, p: -1, pulling: false };
function sendAim(force) {
  if (!myTurnAiming()) return;
  const now = performance.now();
  const a = G.myAim.a;
  const p = G.pull.active ? G.pull.power : 0;
  const pulling = G.pull.active;
  const changed = Math.abs(a - lastSentAim.a) > 0.0008 ||
                  Math.abs(p - lastSentAim.p) > 0.004 ||
                  pulling !== lastSentAim.pulling;
  if (!force && (!changed || now - lastAimSent < 40)) return;
  lastAimSent = now;
  lastSentAim = { a, p, pulling };
  send({ t: 'aim', a, p, pulling, off: G.myAim.off });
}

/* ================= 主循环 ================= */
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (G.pull.active && G.pull.charge && myTurnAiming()) {
    G.pull.power = Math.min(1, G.pull.power + dt / 1.3);
    sendAim();
  }
  draw(now);
  $('aimValue').textContent = ((G.myAim.a * 180 / Math.PI % 360 + 360) % 360).toFixed(1) + '°';
  updateStatus();
  requestAnimationFrame(frame);
}

/* ================= 启动 ================= */
$('muteBtn').textContent = SFX.muted ? '🔇' : '🔊';
$('muteBtn').onclick = () => {
  $('muteBtn').textContent = SFX.toggle() ? '🔇' : '🔊';
};
$('adminBtn').onclick = toggleAdminPanel;

/* 击球点控件事件 */
const tipWidget = $('tipWidget');
tipWidget.addEventListener('pointerdown', e => {
  if (!tipWidget.classList.contains('active')) return;
  tipDrag = true;
  try { tipWidget.setPointerCapture(e.pointerId); } catch (err) {}
  setTipFromEvent(e);
  e.preventDefault();
});
tipWidget.addEventListener('pointermove', e => { if (tipDrag) setTipFromEvent(e); });
tipWidget.addEventListener('pointerup', () => { tipDrag = false; });
tipWidget.addEventListener('pointercancel', () => { tipDrag = false; });
tipWidget.addEventListener('dblclick', () => {
  G.myAim.off = [0, 0];
  updateTipDot();
  sendAim(true);
});

resize();
connect();
requestAnimationFrame(frame);
updateTipDot();

function setPrecisionTip(a, b) {
  if (!myTurnAiming()) return;
  const length = Math.hypot(a, b);
  const scale = length > 0.55 ? 0.55 / length : 1;
  G.myAim.off = [a * scale, b * scale];
  updateTipDot();
  sendAim(true);
}
document.querySelectorAll('[data-tip]').forEach(button => {
  button.onclick = () => setPrecisionTip(...button.dataset.tip.split(',').map(Number));
});
$('sideSpin').oninput = e => setPrecisionTip(+e.target.value / 100, G.myAim.off[1]);
$('topSpin').oninput = e => setPrecisionTip(G.myAim.off[0], +e.target.value / 100);
$('shotPower').oninput = e => {
  G.precisePower = +e.target.value / 100;
  $('shotPowerValue').textContent = e.target.value + '%';
};
for (const [id, sign] of [['aimMinus', -1], ['aimPlus', 1]]) {
  $(id).onclick = () => {
    if (!myTurnAiming()) return;
    $('aimLock').checked = true;
    G.myAim.a += sign * Math.PI / 1800;
    sendAim(true);
  };
}
$('preciseShoot').onclick = () => {
  if (!myTurnAiming() || G.pull.active) return;
  send({ t: 'shoot', a: G.myAim.a, p: G.precisePower, off: G.myAim.off });
};

/* 调试钩子(?test=1 时可用) */
window.__errs = [];
window.addEventListener('error', e => window.__errs.push(String(e.message || e)));
window.addEventListener('unhandledrejection', e => window.__errs.push('promise:' + String(e.reason)));
if (/[?&]test=1/.test(location.search)) {
  window.__test = {
    join(name) {
      const inp = $('joinName');
      if (inp) { inp.value = name || '测试'; $('joinBtn').click(); }
      else send({ t: 'hello', name: name || '测试' });
    },
    aim(a, p, pulling, off) {
      G.myAim.a = a;
      if (off) G.myAim.off = off;
      G.pull.active = !!pulling;
      G.pull.power = p || 0;
      sendAim(true);
    },
    shoot(a, p, off) { send({ t: 'shoot', a, p, off: off || [0, 0] }); },
    place(x, y) { send({ t: 'place', x, y }); },
    set(balls) { send({ t: 'test', cmd: 'set', balls }); },
    setg(groups, open) { send({ t: 'test', cmd: 'setg', groups, open }); },
    rematch() { send({ t: 'rematch' }); },
    sfx() { return SFX.debug(); },
    state() {
      return {
        seat: G.my.seat,
        phase: G.room && G.room.phase,
        turn: G.room && G.room.turn,
        groups: G.room && G.room.groups,
        open: G.room && G.room.open,
        winner: G.room && G.room.winner,
        balls: G.balls.filter(Boolean).map(b => [b.id, Math.round(b.x), Math.round(b.y), b.potted ? 1 : 0]),
      };
    },
  };
}
})();
