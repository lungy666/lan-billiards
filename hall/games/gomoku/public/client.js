/*
 * hall/games/gomoku/public/client.js —— 五子棋前端
 *
 * 这是"进程内游戏"前端接入的参考实现。大厅在进入房间时加载本脚本,
 * 随后调用 HallGames.gomoku.mount(container, api)。
 * 与服务器通信统一走 api.send(游戏消息),接收走 onMessage / onSnapshot。
 */
(function () {
  'use strict';
  window.HallGames = window.HallGames || {};

  const SIZE = 15;
  const STAR = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
  const G = {
    api: null,
    container: null,
    cv: null,
    ctx: null,
    statusEl: null,
    btnEl: null,
    state: null,
    hover: null,
    geom: { size: 0, origin: 0, cell: 0 },
  };

  function myNum() {
    const me = G.api && G.api.me;
    return me && me.seat !== null && me.seat !== undefined ? me.seat + 1 : 0;
  }

  function onResize() {
    if (!G.cv) return;
    const wrap = G.container;
    const availW = Math.max(240, (wrap.clientWidth || 600) - 16);
    const availH = Math.max(240, (wrap.clientHeight || 600) - 60);
    const size = Math.min(availW, availH);
    const dpr = window.devicePixelRatio || 1;
    G.cv.style.width = size + 'px';
    G.cv.style.height = size + 'px';
    G.cv.width = Math.round(size * dpr);
    G.cv.height = Math.round(size * dpr);
    const origin = size * 0.045;
    const cell = (size - origin * 2) / (SIZE - 1);
    G.geom = { size, origin, cell, dpr };
    draw();
  }

  function px(gx) { return G.geom.origin + gx * G.geom.cell; }

  function draw() {
    const c = G.ctx;
    if (!c) return;
    const { size, origin, cell, dpr } = G.geom;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, size, size);

    // 木纹底
    const wood = c.createLinearGradient(0, 0, size, size);
    wood.addColorStop(0, '#e8c88a');
    wood.addColorStop(0.5, '#dfb974');
    wood.addColorStop(1, '#cfa25c');
    c.fillStyle = wood;
    c.fillRect(0, 0, size, size);
    c.strokeStyle = 'rgba(120,80,30,0.35)';
    c.lineWidth = 1;
    c.strokeRect(0.5, 0.5, size - 1, size - 1);

    // 网格
    c.strokeStyle = 'rgba(60,40,15,0.75)';
    c.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      c.beginPath();
      c.moveTo(px(i), px(0));
      c.lineTo(px(i), px(SIZE - 1));
      c.stroke();
      c.beginPath();
      c.moveTo(px(0), px(i));
      c.lineTo(px(SIZE - 1), px(i));
      c.stroke();
    }
    // 星位
    c.fillStyle = 'rgba(40,25,8,0.9)';
    for (const [x, y] of STAR) {
      c.beginPath();
      c.arc(px(x), px(y), Math.max(2, cell * 0.09), 0, 7);
      c.fill();
    }

    const s = G.state;
    if (!s || !s.board) return;

    // 悬停预览
    if (G.hover && s.started && !s.winner) {
      const [hx, hy] = G.hover;
      if (s.board[hy] && s.board[hy][hx] === 0 && myNum() === s.turn) {
        c.globalAlpha = 0.32;
        drawStone(c, px(hx), px(hy), myNum(), cell);
        c.globalAlpha = 1;
      }
    }

    // 棋子
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const v = s.board[y][x];
        if (v) drawStone(c, px(x), px(y), v, cell);
      }
    }

    // 最后一手标记
    if (s.last) {
      const [lx, ly] = s.last;
      c.beginPath();
      c.arc(px(lx), px(ly), Math.max(2.5, cell * 0.13), 0, 7);
      c.strokeStyle = '#e23b3b';
      c.lineWidth = Math.max(1.5, cell * 0.06);
      c.stroke();
    }

    updateStatus();
  }

  function drawStone(c, cx, cy, p, cell) {
    const r = cell * 0.42;
    const dark = p === 1;
    const grad = c.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r);
    if (dark) {
      grad.addColorStop(0, '#6f6f6f');
      grad.addColorStop(0.45, '#333');
      grad.addColorStop(1, '#050505');
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.6, '#f2f0ea');
      grad.addColorStop(1, '#c8c4ba');
    }
    c.beginPath();
    c.arc(cx, cy, r, 0, 7);
    c.fillStyle = grad;
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = dark ? 'rgba(0,0,0,0.6)' : 'rgba(120,115,105,0.7)';
    c.stroke();
  }

  function playerLabel(n) {
    if (G.state && G.state.seats) {
      const s = G.state.seats[n - 1];
      if (s && s.name) return s.name;
    }
    return n === 1 ? '黑方' : '白方';
  }

  function updateStatus() {
    if (!G.statusEl) return;
    const s = G.state;
    const me = myNum();
    let txt = '载入中…';
    let showBtn = false;

    if (s) {
      if (s.winner === 3) txt = '平局';
      else if (s.winner) txt = `🏆 ${playerLabel(s.winner)} 获胜!`;
      else if (!s.started) txt = '等待双方就座…';
      else if (me === s.turn) txt = `轮到你落子(${me === 1 ? '● 黑' : '○ 白'})`;
      else if (me) txt = `等待 ${playerLabel(s.turn)} 落子…`;
      else txt = `${playerLabel(s.turn)} 思考中…`;

      if (s.winner && me) {
        showBtn = true;
        if (s.rematch && s.rematch[me - 1]) {
          txt = '已请求再来一局,等待对方…';
        }
      }
    }
    if (G.statusEl.textContent !== txt) G.statusEl.textContent = txt;
    if (G.btnEl) G.btnEl.style.display = showBtn ? '' : 'none';
  }

  function toGrid(e) {
    const rect = G.cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (G.geom.size / rect.width);
    const y = (e.clientY - rect.top) * (G.geom.size / rect.height);
    const gx = Math.round((x - G.geom.origin) / G.geom.cell);
    const gy = Math.round((y - G.geom.origin) / G.geom.cell);
    if (gx < 0 || gx >= SIZE || gy < 0 || gy >= SIZE) return null;
    return [gx, gy];
  }

  function onClick(e) {
    const s = G.state;
    if (!s || !s.started || s.winner) return;
    if (myNum() !== s.turn) return;
    const g = toGrid(e);
    if (!g) return;
    if (s.board[g[1]][g[0]] !== 0) return;
    G.api.send({ a: 'place', x: g[0], y: g[1] });
  }

  function onMove(e) {
    G.hover = toGrid(e);
    draw();
  }

  window.HallGames.gomoku = {
    mount(container, api) {
      G.api = api;
      G.container = container;
      G.state = api.snapshot || null;
      container.innerHTML = '';

      const root = document.createElement('div');
      root.className = 'gomoku';

      const bar = document.createElement('div');
      bar.className = 'gomoku-bar';
      G.statusEl = document.createElement('span');
      G.statusEl.className = 'gomoku-status';
      G.btnEl = document.createElement('button');
      G.btnEl.className = 'gomoku-btn';
      G.btnEl.textContent = '再来一局';
      G.btnEl.style.display = 'none';
      G.btnEl.onclick = () => G.api.send({ a: 'rematch' });
      bar.appendChild(G.statusEl);
      bar.appendChild(G.btnEl);

      const cv = document.createElement('canvas');
      cv.className = 'gomoku-cv';
      cv.addEventListener('click', onClick);
      cv.addEventListener('mousemove', onMove);
      cv.addEventListener('mouseleave', () => { G.hover = null; draw(); });
      G.cv = cv;
      G.ctx = cv.getContext('2d');

      root.appendChild(bar);
      root.appendChild(cv);
      container.appendChild(root);

      G._onResize = onResize;
      window.addEventListener('resize', onResize);
      onResize();
    },

    unmount() {
      if (G._onResize) window.removeEventListener('resize', G._onResize);
      G._onResize = null;
      G.cv = null;
      G.ctx = null;
      G.container = null;
    },

    onSnapshot(s) {
      G.state = s;
      draw();
    },

    onMessage(m) {
      if (m && m.a === 'state') {
        G.state = m;
        draw();
      }
    },

    onRoom() {
      draw();
    },
  };
})();
