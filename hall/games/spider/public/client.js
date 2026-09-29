/*
 * hall/games/spider/public/client.js —— 蜘蛛纸牌前端
 *
 * 特性:
 *   - 进房先选难度(简单/普通/困难),可随时「新游戏」重开;
 *   - Canvas 绘制精致牌桌 + 纸牌(渐变、牌背花纹、阴影、金框选中);
 *   - 基于牌 id 的位置补间:发牌 / 移动 / 收牌会自动滑动;
 *   - 拖拽 + 点选两种操作,空列/非法落点实时高亮;
 *   - 通关撒花 + 结算面板。
 * 与服务器通信统一走 api.send(游戏消息),状态由服务端权威下发。
 */
(function () {
  'use strict';
  window.HallGames = window.HallGames || {};

  const SUITS = ['\u2660', '\u2665', '\u2663', '\u2666'];   // ♠ ♥ ♣ ♦
  const RED = [false, true, false, true];
  const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const COLS = 10;

  const DIFFS = [
    { suits: 1, name: '简单', sub: '单花色', desc: '只用黑桃,轻松上手', color: '#16a34a', icon: '\u2660' },
    { suits: 2, name: '普通', sub: '双花色', desc: '黑桃 + 红桃', color: '#ea8a0b', icon: '\u2665' },
    { suits: 4, name: '困难', sub: '四花色', desc: '四种花色全上阵', color: '#dc2626', icon: '\u2666' },
  ];
  const CONFETTI = ['#fbbf24', '#f472b6', '#60a5fa', '#34d399', '#f87171', '#a78bfa', '#fde68a'];

  const G = {
    api: null, container: null, root: null, bar: null, stage: null, cv: null, ctx: null,
    statusEl: null, dealBtn: null, undoBtn: null, newBtn: null, diffPill: null,
    startEl: null, startRow: null, startWait: null, startCancel: null, startTitle: null,
    state: null, geom: null, sel: null, drag: null, pressStock: false, showStart: false,
    pos: null, animating: false, raf: null, confetti: null,
    _onResize: null, _ro: null,
  };

  function isSpectator() {
    const me = G.api && G.api.me;
    return !!(me && (me.spectator || me.seat === null || me.seat === undefined));
  }

  /* ============================ 尺寸 / 几何 ============================ */
  function baseLayout() {
    const el = G.stage;
    const W = Math.max(300, el.clientWidth);
    const H = Math.max(220, el.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const gap = Math.max(4, W * 0.008);
    let cardW = (W - gap * (COLS + 1)) / COLS;
    cardW = Math.min(cardW, 88);
    cardW = Math.max(cardW, 20);
    const cardH = cardW * 1.44;
    const contentW = cardW * COLS + gap * (COLS - 1);
    const x0 = Math.max(gap, (W - contentW) / 2);
    const padY = Math.max(6, H * 0.014);
    G.geom = {
      W, H, dpr, gap, cardW, cardH, x0, padY,
      tableauY: padY,                       // 接龙区在顶部
      bottomY: H - padY - cardH,            // 收牌 / 发牌区在底部
      fd: 0, fu: 0,
      stockRect: null, stockCenter: null, targetCol: -1, targetOk: false,
    };
    G.cv.style.width = W + 'px';
    G.cv.style.height = H + 'px';
    G.cv.width = Math.round(W * dpr);
    G.cv.height = Math.round(H * dpr);
  }

  function colX(c) { return G.geom.x0 + c * (G.geom.cardW + G.geom.gap); }

  function colHeight(col, fd, fu) {
    let y = 0;
    for (let i = 0; i < col.length - 1; i++) y += col[i].u ? fu : fd;
    return y + G.geom.cardH;
  }

  function computeOffsets() {
    const g = G.geom;
    let fd = g.cardH * 0.16;
    let fu = g.cardH * 0.34;
    const s = G.state;
    if (s && s.columns && s.columns.length) {
      const avail = Math.max(40, g.bottomY - g.tableauY - Math.max(10, g.H * 0.02));
      let need = g.cardH;
      for (const col of s.columns) need = Math.max(need, colHeight(col, fd, fu));
      if (need > avail) {
        const k = avail / need;
        fd *= k; fu *= k;
      }
    }
    g.fd = fd; g.fu = fu;
  }

  // 某列的静态布局(未加动画)
  function columnLayout(ci) {
    const g = G.geom, col = G.state.columns[ci];
    const out = [];
    let y = g.tableauY;
    for (let i = 0; i < col.length; i++) {
      out.push({ i, card: col[i], x: colX(ci), y });
      y += col[i].u ? g.fu : g.fd;
    }
    return out;
  }

  function drawnPos(item) {
    const p = G.pos && G.pos.get(item.card.id);
    return p ? { x: p.x, y: p.y } : { x: item.x, y: item.y };
  }

  /* ============================== 动画 =============================== */
  function animTo(id, tx, ty) {
    let p = G.pos.get(id);
    if (!p) {
      const sc = G.geom.stockCenter || { x: tx, y: ty };
      p = { x: sc.x, y: sc.y };
      G.pos.set(id, p);
    }
    const dx = tx - p.x, dy = ty - p.y;
    if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) {
      p.x = tx; p.y = ty;
    } else {
      p.x += dx * 0.30; p.y += dy * 0.30;
      G.animating = true;
    }
    return p;
  }

  function scheduleFrame() {
    if (G.raf) return;
    G.raf = requestAnimationFrame(() => { G.raf = null; draw(); });
  }

  function spawnConfetti() {
    if (!G.geom) return;
    const n = 110;
    G.confetti = [];
    for (let i = 0; i < n; i++) {
      G.confetti.push({
        x: Math.random() * G.geom.W,
        y: -20 - Math.random() * G.geom.H * 0.6,
        vx: (Math.random() - 0.5) * 1.8,
        vy: 1.6 + Math.random() * 2.6,
        s: 4 + Math.random() * 6,
        rot: Math.random() * 6.28,
        vr: (Math.random() - 0.5) * 0.35,
        c: CONFETTI[(Math.random() * CONFETTI.length) | 0],
      });
    }
  }

  function updateConfetti() {
    if (!G.confetti || !G.confetti.length) return;
    const H = G.geom.H, W = G.geom.W;
    const keep = [];
    for (const p of G.confetti) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.03; p.rot += p.vr;
      if (p.y < H + 30 && p.x > -30 && p.x < W + 30) keep.push(p);
    }
    G.confetti = keep;
  }

  function drawConfetti(c) {
    if (!G.confetti || !G.confetti.length) return;
    for (const p of G.confetti) {
      c.save();
      c.translate(p.x, p.y);
      c.rotate(p.rot);
      c.globalAlpha = 0.95;
      c.fillStyle = p.c;
      c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      c.restore();
    }
  }

  /* ============================== 绘制 =============================== */
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawCard(c, card, x, y, w, h, opt) {
    opt = opt || {};
    const r = Math.max(2.5, w * 0.10);

    if (!card.u) { // 牌背
      const g = c.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, '#4a6fc4');
      g.addColorStop(0.45, '#2b4a92');
      g.addColorStop(1, '#152751');
      rr(c, x, y, w, h, r); c.fillStyle = g; c.fill();

      // 内描边
      rr(c, x + 2, y + 2, w - 4, h - 4, r * 0.8);
      c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = 1; c.stroke();

      c.save(); rr(c, x + 2, y + 2, w - 4, h - 4, r * 0.8); c.clip();
      // 斜纹底
      c.strokeStyle = 'rgba(255,255,255,.09)';
      c.lineWidth = Math.max(1, w * 0.03);
      const step = Math.max(5, w * 0.22);
      for (let d = -h; d < w; d += step) {
        c.beginPath(); c.moveTo(x + d, y + h); c.lineTo(x + d + h, y); c.stroke();
      }
      // 中央徽章
      const cx = x + w / 2, cy = y + h / 2, dm = Math.min(w, h) * 0.30;
      const med = c.createRadialGradient(cx, cy, dm * 0.1, cx, cy, dm);
      med.addColorStop(0, 'rgba(255,255,255,.18)');
      med.addColorStop(1, 'rgba(255,255,255,0)');
      c.beginPath(); c.arc(cx, cy, dm, 0, 7); c.fillStyle = med; c.fill();
      c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = Math.max(1, w * 0.026);
      c.beginPath();
      c.moveTo(cx, cy - dm * 0.86); c.lineTo(cx + dm * 0.68, cy);
      c.lineTo(cx, cy + dm * 0.86); c.lineTo(cx - dm * 0.68, cy); c.closePath(); c.stroke();
      c.beginPath(); c.arc(cx, cy, dm * 0.30, 0, 7); c.stroke();
      c.fillStyle = 'rgba(255,255,255,.85)';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = (dm * 0.62) + 'px "Segoe UI Symbol", "Segoe UI", system-ui, sans-serif';
      c.fillText('\u2660', cx, cy + dm * 0.04);
      c.restore();

      rr(c, x + 0.5, y + 0.5, w - 1, h - 1, r);
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1; c.stroke();
      return;
    }

    // 牌面
    c.save();
    c.shadowColor = 'rgba(0,0,0,.34)';
    c.shadowBlur = Math.max(3, w * 0.11);
    c.shadowOffsetY = Math.max(1, h * 0.018);
    rr(c, x, y, w, h, r);
    const face = c.createLinearGradient(x, y, x, y + h);
    face.addColorStop(0, '#ffffff');
    face.addColorStop(0.55, '#fbf9f2');
    face.addColorStop(1, '#efeade');
    c.fillStyle = face; c.fill();
    c.restore();

    // 外描边 + 内金线
    rr(c, x + 0.5, y + 0.5, w - 1, h - 1, r);
    c.strokeStyle = 'rgba(30,42,66,.34)'; c.lineWidth = 1; c.stroke();
    rr(c, x + 2, y + 2, w - 4, h - 4, r * 0.78);
    c.strokeStyle = 'rgba(206,180,110,.6)'; c.lineWidth = 1; c.stroke();

    const ink = RED[card.s] ? '#d3283a' : '#1b2434';
    const fs = Math.max(8, w * 0.33);
    const ss = Math.max(8, w * 0.33);
    // 左上角标
    c.fillStyle = ink;
    c.textAlign = 'left'; c.textBaseline = 'top';
    c.font = '800 ' + fs + 'px "Segoe UI", system-ui, sans-serif';
    c.fillText(RANKS[card.r], x + w * 0.11, y + h * 0.05);
    c.font = ss + 'px "Segoe UI Symbol", "Segoe UI", system-ui, sans-serif';
    c.fillText(SUITS[card.s], x + w * 0.11, y + h * 0.05 + fs * 1.02);

    // 中央大花色水印
    c.globalAlpha = 0.11;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = (w * 0.78) + 'px "Segoe UI Symbol", "Segoe UI", system-ui, sans-serif';
    c.fillText(SUITS[card.s], x + w / 2, y + h * 0.60);
    c.globalAlpha = 1;

    // 右下角倒置角标(翻看整列时可见)
    c.save();
    c.translate(x + w * 0.87, y + h * 0.95); c.rotate(Math.PI);
    c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillStyle = ink; c.globalAlpha = 0.82;
    c.font = '800 ' + (fs * 0.7) + 'px "Segoe UI", system-ui, sans-serif';
    c.fillText(RANKS[card.r], 0, 0);
    c.restore();
    c.globalAlpha = 1;

    if (opt.selected) {
      c.save();
      c.shadowColor = 'rgba(255,205,60,.95)';
      c.shadowBlur = Math.max(6, w * 0.22);
      rr(c, x + 1.5, y + 1.5, w - 3, h - 3, r);
      c.strokeStyle = '#ffce3a'; c.lineWidth = Math.max(2, w * 0.055); c.stroke();
      c.restore();
    }
    if (opt.dim) {
      rr(c, x, y, w, h, r);
      c.fillStyle = 'rgba(255,255,255,.58)'; c.fill();
    }
  }

  function drawMedal(c, cx, cy, r, suit) {
    if (suit === null) {
      c.beginPath(); c.arc(cx, cy, r, 0, 7);
      c.fillStyle = 'rgba(255,255,255,.05)'; c.fill();
      c.setLineDash([3, 3]);
      c.strokeStyle = 'rgba(255,255,255,.30)'; c.lineWidth = 1.2; c.stroke();
      c.setLineDash([]);
      return;
    }
    c.save();
    c.shadowColor = 'rgba(0,0,0,.4)'; c.shadowBlur = r * 0.6; c.shadowOffsetY = r * 0.14;
    const grad = c.createRadialGradient(cx - r * 0.35, cy - r * 0.45, r * 0.12, cx, cy, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#e7e0cf');
    c.beginPath(); c.arc(cx, cy, r, 0, 7);
    c.fillStyle = grad; c.fill();
    c.restore();
    c.beginPath(); c.arc(cx, cy, Math.max(1, r - 1), 0, 7);
    c.strokeStyle = 'rgba(212,175,55,.92)'; c.lineWidth = Math.max(1.4, r * 0.13); c.stroke();
    c.beginPath(); c.arc(cx, cy, r * 0.80, 0, 7);
    c.strokeStyle = 'rgba(212,175,55,.35)'; c.lineWidth = 1; c.stroke();
    c.fillStyle = RED[suit] ? '#d3283a' : '#1b2434';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = (r * 1.18) + 'px "Segoe UI Symbol", "Segoe UI", system-ui, sans-serif';
    c.fillText(SUITS[suit], cx, cy + r * 0.05);
  }

  function drawBottomBar(c) {
    const g = G.geom, s = G.state;
    const total = (s && s.totalSets) || 8;

    // 底部衬板(把操作区与牌桌分开)
    const bandTop = g.bottomY - Math.max(10, g.H * 0.035);
    const band = c.createLinearGradient(0, bandTop, 0, g.H);
    band.addColorStop(0, 'rgba(0,0,0,0)');
    band.addColorStop(0.5, 'rgba(0,0,0,.16)');
    band.addColorStop(1, 'rgba(0,0,0,.32)');
    c.fillStyle = band;
    c.fillRect(0, bandTop, g.W, g.H - bandTop);
    c.strokeStyle = 'rgba(255,255,255,.07)';
    c.beginPath(); c.moveTo(0, bandTop + 1); c.lineTo(g.W, bandTop + 1); c.stroke();

    // 牌堆(右下)
    const sw = g.cardW, sh = g.cardH;
    const sx = g.x0 + g.cardW * COLS + g.gap * (COLS - 1) - sw;
    const sy = g.bottomY;
    g.stockRect = { x: sx, y: sy, w: sw, h: sh };
    g.stockCenter = { x: sx + sw / 2, y: sy + sh / 2 };
    const n = s && s.stock ? s.stock : 0;
    if (n > 0) {
      if (n > 20) drawCard(c, { u: 0 }, sx + Math.max(3, sw * 0.05), sy + Math.max(2, sh * 0.012), sw, sh, {});
      if (n > 10) drawCard(c, { u: 0 }, sx + Math.max(1.5, sw * 0.025), sy + Math.max(1, sh * 0.006), sw, sh, {});
      drawCard(c, { u: 0 }, sx, sy, sw, sh, {});
      const br = Math.max(9, sw * 0.25);
      const bx = sx + sw - br * 0.28, by = sy + br * 0.28;
      c.beginPath(); c.arc(bx, by, br, 0, 7);
      const bg2 = c.createLinearGradient(bx, by - br, bx, by + br);
      bg2.addColorStop(0, '#ffffff'); bg2.addColorStop(1, '#e8edf5');
      c.fillStyle = bg2; c.fill();
      c.strokeStyle = 'rgba(30,42,66,.28)'; c.lineWidth = 1; c.stroke();
      c.fillStyle = '#1b2434'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '800 ' + (br * 0.92) + 'px "Segoe UI", system-ui, sans-serif';
      c.fillText(String(n), bx, by + 1);
    } else {
      rr(c, sx, sy, sw, sh, sw * 0.1);
      c.fillStyle = 'rgba(255,255,255,.05)'; c.fill();
      c.setLineDash([5, 4]);
      c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 1.2; c.stroke();
      c.setLineDash([]);
      c.fillStyle = 'rgba(255,255,255,.42)';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = Math.max(10, sw * 0.26) + 'px "Segoe UI", system-ui, sans-serif';
      c.fillText('空', sx + sw / 2, sy + sh / 2);
    }

    // 收牌徽章(左下,8 枚不重叠)
    const badgesLeft = g.x0;
    const badgesRight = sx - Math.max(12, g.gap * 2);
    const areaW = Math.max(80, badgesRight - badgesLeft);
    const gapB = Math.max(6, areaW * 0.014);
    let d = (areaW - gapB * (total - 1)) / total;
    d = Math.min(d, g.cardH * 0.82);
    d = Math.max(d, 16);
    const totalW = d * total + gapB * (total - 1);
    const startX = badgesLeft + Math.max(0, (areaW - totalW) / 2);
    const cy = g.bottomY + g.cardH / 2;
    const done = s && s.foundations ? s.foundations.length : 0;
    for (let i = 0; i < total; i++) {
      const cx = startX + d / 2 + i * (d + gapB);
      drawMedal(c, cx, cy, d / 2, i < done ? s.foundations[i] : null);
    }
  }

  function drawTableau(c) {
    const s = G.state;
    if (!s || !s.columns) return;
    const g = G.geom;
    for (let ci = 0; ci < s.columns.length; ci++) {
      const col = s.columns[ci];
      const x = colX(ci);

      if (!col.length) {
        const hot = G.drag && g.targetCol === ci && G.drag.from !== ci;
        rr(c, x, g.tableauY, g.cardW, g.cardH, g.cardW * 0.1);
        c.fillStyle = hot ? (g.targetOk ? 'rgba(124,252,155,.16)' : 'rgba(255,107,107,.14)') : 'rgba(255,255,255,.05)';
        c.fill();
        c.setLineDash([5, 4]);
        c.strokeStyle = hot ? (g.targetOk ? '#7CFC9B' : '#ff6b6b') : 'rgba(255,255,255,.26)';
        c.lineWidth = hot ? 2.5 : 1.4; c.stroke();
        c.setLineDash([]);
        continue;
      }

      const layout = columnLayout(ci);
      for (const item of layout) {
        const p = animTo(item.card.id, item.x, item.y);
        const opts = {};
        if (G.sel && G.sel.from === ci && item.i >= G.sel.index) opts.selected = true;
        if (G.drag && G.drag.from === ci && item.i >= G.drag.index) opts.dim = true;
        drawCard(c, item.card, p.x, p.y, g.cardW, g.cardH, opts);
      }

      if (G.drag && g.targetCol === ci && G.drag.from !== ci) {
        const last = layout[layout.length - 1];
        rr(c, x - 2, last.y - 2, g.cardW + 4, g.cardH + 4, g.cardW * 0.11);
        c.strokeStyle = g.targetOk ? '#7CFC9B' : '#ff6b6b';
        c.lineWidth = 2.5; c.stroke();
      }
    }
  }

  function drawDragged(c) {
    const d = G.drag;
    if (!d) return;
    const g = G.geom;
    const x = d.x - d.grabX;
    let y = d.y - d.grabY;
    const dy = Math.max(7, g.fu * 0.5);
    for (let i = 0; i < d.cards.length; i++) {
      drawCard(c, d.cards[i], x, y, g.cardW, g.cardH, {});
      y += dy;
    }
  }

  function drawWin(c) {
    const s = G.state, g = G.geom;
    c.fillStyle = 'rgba(6,18,12,.55)';
    c.fillRect(0, 0, g.W, g.H);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.save();
    c.shadowColor = 'rgba(255,210,80,.55)'; c.shadowBlur = 24;
    c.fillStyle = '#ffe07a';
    c.font = '900 ' + Math.max(28, g.W * 0.052) + 'px "Segoe UI", system-ui, sans-serif';
    c.fillText('\uD83C\uDF89 恭喜通关!', g.W / 2, g.H / 2 - g.H * 0.05);
    c.restore();
    c.fillStyle = '#ffffff';
    c.font = '700 ' + Math.max(13, g.W * 0.019) + 'px "Segoe UI", system-ui, sans-serif';
    c.fillText('最终分数 ' + s.score + ' · 共 ' + s.moves + ' 步', g.W / 2, g.H / 2 + g.H * 0.02);
    c.fillStyle = 'rgba(255,255,255,.78)';
    c.font = Math.max(12, g.W * 0.014) + 'px "Segoe UI", system-ui, sans-serif';
    c.fillText('点击「新游戏」再挑战其它难度', g.W / 2, g.H / 2 + g.H * 0.07);
  }

  function draw() {
    const c = G.ctx;
    if (!c || !G.geom) return;
    G.animating = false;
    computeOffsets();
    const g = G.geom;
    c.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);

    // 绒面
    const bg = c.createLinearGradient(0, 0, 0, g.H);
    bg.addColorStop(0, '#1a8a58');
    bg.addColorStop(0.5, '#0f6a42');
    bg.addColorStop(1, '#083d27');
    c.fillStyle = bg;
    c.fillRect(0, 0, g.W, g.H);
    const glow = c.createRadialGradient(g.W * 0.5, g.H * 0.08, 10, g.W * 0.5, g.H * 0.08, g.H * 1.05);
    glow.addColorStop(0, 'rgba(255,255,255,.13)');
    glow.addColorStop(0.5, 'rgba(255,255,255,.03)');
    glow.addColorStop(1, 'rgba(0,0,0,.28)');
    c.fillStyle = glow;
    c.fillRect(0, 0, g.W, g.H);
    // 细纹
    c.globalAlpha = 0.04;
    c.strokeStyle = '#ffffff'; c.lineWidth = 1;
    for (let d = -g.H; d < g.W; d += 26) {
      c.beginPath(); c.moveTo(d, g.H); c.lineTo(d + g.H, 0); c.stroke();
    }
    c.globalAlpha = 1;

    // 中央大水印,让空桌更精致
    const midY = (g.tableauY + g.bottomY) / 2;
    c.save();
    c.globalAlpha = 0.05;
    c.fillStyle = '#ffffff';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = Math.min(g.H * 0.55, g.W * 0.42) + 'px "Segoe UI Symbol", "Segoe UI", system-ui, sans-serif';
    c.fillText('\u2660', g.W / 2, midY);
    c.restore();

    const s = G.state;
    if (!s || !s.started) {
      if (G.animating || (G.confetti && G.confetti.length)) scheduleFrame();
      return;
    }

    drawBottomBar(c);
    drawTableau(c);
    drawDragged(c);
    if (s.won) { updateConfetti(); drawWin(c); drawConfetti(c); }

    if (G.animating || (G.confetti && G.confetti.length)) scheduleFrame();
  }

  /* ============================ 规则(前端预判) ============================ */
  function runStartClient(col, idx) {
    if (idx < 0 || idx >= col.length || !col[idx].u) return false;
    for (let i = idx; i < col.length - 1; i++) {
      const a = col[i], b = col[i + 1];
      if (!b.u || a.s !== b.s || a.r !== b.r + 1) return false;
    }
    return true;
  }

  function canPlaceClient(card, col) {
    if (!col || !col.length) return true;
    const top = col[col.length - 1];
    return !!top.u && top.r === card.r + 1;
  }

  function hasEmptyColumn(s) {
    if (!s || !s.columns) return false;
    return s.columns.some(col => col.length === 0);
  }

  /* ============================== 输入 =============================== */
  function toLocal(e) {
    const r = G.cv.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (G.geom.W / r.width),
      y: (e.clientY - r.top) * (G.geom.H / r.height),
    };
  }

  function pointInRect(p, r) {
    return !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  function colAtX(x) {
    const g = G.geom;
    const ci = Math.floor((x - g.x0) / (g.cardW + g.gap));
    return (ci < 0 || ci >= COLS) ? -1 : ci;
  }

  function hitCard(p) {
    const s = G.state;
    if (!s || !s.columns) return null;
    const g = G.geom;
    for (let ci = 0; ci < s.columns.length; ci++) {
      const layout = columnLayout(ci);
      let found = null;
      for (const item of layout) {
        const pos = drawnPos(item);
        if (p.x >= pos.x && p.x <= pos.x + g.cardW && p.y >= pos.y && p.y <= pos.y + g.cardH) {
          found = { col: ci, index: item.i, rect: { x: pos.x, y: pos.y, w: g.cardW, h: g.cardH } };
        }
      }
      if (found) return found;
    }
    return null;
  }

  function tryMoveSelectedTo(ci) {
    if (!G.sel || ci < 0 || ci === G.sel.from || isSpectator()) return false;
    const src = G.state.columns[G.sel.from];
    const card = src && src[G.sel.index];
    if (card && canPlaceClient(card, G.state.columns[ci])) {
      G.api.send({ a: 'move', from: G.sel.from, index: G.sel.index, to: ci });
      G.sel = null;
      draw();
      return true;
    }
    return false;
  }

  function onDown(e) {
    if (!G.state || !G.state.started || !G.geom || G.showStart) return;
    const p = toLocal(e);
    try { G.cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    if (pointInRect(p, G.geom.stockRect)) {
      if (!isSpectator()) G.pressStock = true;
      return;
    }

    const hit = hitCard(p);
    if (!hit) {
      if (tryMoveSelectedTo(colAtX(p.x))) return;
      G.sel = null; draw();
      return;
    }

    const col = G.state.columns[hit.col];
    const card = col[hit.index];
    if (!card.u || !runStartClient(col, hit.index)) {
      G.sel = null; draw();
      return;
    }
    if (isSpectator()) return;

    G.drag = {
      from: hit.col, index: hit.index,
      cards: col.slice(hit.index).map(x => ({ id: x.id, u: x.u, s: x.s, r: x.r })),
      startX: p.x, startY: p.y, x: p.x, y: p.y,
      grabX: p.x - hit.rect.x, grabY: p.y - hit.rect.y,
      moved: false,
      prevSel: G.sel,
    };
    G.sel = null;
    draw();
  }

  function onMove(e) {
    if (!G.drag) return;
    const p = toLocal(e);
    G.drag.x = p.x; G.drag.y = p.y;
    if (Math.abs(p.x - G.drag.startX) + Math.abs(p.y - G.drag.startY) > 5) G.drag.moved = true;

    const g = G.geom;
    let ci = colAtX(p.x); if (ci < 0) ci = p.x < g.x0 ? 0 : COLS - 1;
    g.targetCol = ci;
    g.targetOk = ci !== G.drag.from && canPlaceClient(G.drag.cards[0], G.state.columns[ci]);
    draw();
  }

  function onUp(e) {
    if (G.pressStock) {
      G.pressStock = false;
      if (e && !isSpectator()) {
        const p = toLocal(e);
        if (pointInRect(p, G.geom.stockRect)) G.api.send({ a: 'deal' });
      }
      return;
    }
    const d = G.drag;
    if (!d) return;
    G.drag = null;

    if (d.moved) {
      let ci = colAtX(d.x); if (ci < 0) ci = -1;
      if (ci >= 0 && ci !== d.from && canPlaceClient(d.cards[0], G.state.columns[ci])) {
        G.api.send({ a: 'move', from: d.from, index: d.index, to: ci });
      }
      G.geom.targetCol = -1;
      draw();
      return;
    }

    // 点击(未拖动):选中 / 用选中牌组落子
    if (isSpectator()) { draw(); return; }
    const sel = G.sel || d.prevSel;
    if (sel && (sel.from !== d.from || sel.index !== d.index)) {
      G.sel = sel;
      if (!tryMoveSelectedTo(d.from)) G.sel = { from: d.from, index: d.index };
    } else if (sel && sel.from === d.from && sel.index === d.index) {
      G.sel = null;
    } else {
      G.sel = { from: d.from, index: d.index };
    }
    draw();
  }

  function onCancel() {
    G.drag = null;
    G.pressStock = false;
    if (G.geom) G.geom.targetCol = -1;
    draw();
  }

  /* ============================ 难度面板 ============================= */
  function buildStartPanel() {
    const el = document.createElement('div');
    el.className = 'spider-start';

    const inner = document.createElement('div');
    inner.className = 'spider-start-inner';

    const title = document.createElement('div');
    title.className = 'spider-start-title';
    title.textContent = '蜘蛛纸牌';
    G.startTitle = title;

    const sub = document.createElement('div');
    sub.className = 'spider-start-sub';
    sub.textContent = '选择难度开始游戏 · 花色越多挑战越大';

    const wait = document.createElement('div');
    wait.className = 'spider-start-wait';
    wait.textContent = '等待房主选择难度…';
    wait.style.display = 'none';
    G.startWait = wait;

    const row = document.createElement('div');
    row.className = 'spider-start-row';
    G.startRow = row;
    for (const d of DIFFS) {
      const btn = document.createElement('button');
      btn.className = 'spider-start-card';
      btn.style.setProperty('--dc', d.color);
      const ic = document.createElement('span'); ic.className = 'sc-icon'; ic.textContent = d.icon;
      const nm = document.createElement('span'); nm.className = 'sc-name'; nm.textContent = d.name;
      const sb = document.createElement('span'); sb.className = 'sc-sub'; sb.textContent = d.sub;
      const ds = document.createElement('span'); ds.className = 'sc-desc'; ds.textContent = d.desc;
      btn.append(ic, nm, sb, ds);
      btn.onclick = () => {
        G.showStart = false;
        G.api.send({ a: 'new', suits: d.suits });
        refreshStart();
      };
      row.appendChild(btn);
    }

    const cancel = document.createElement('button');
    cancel.className = 'spider-start-cancel';
    cancel.textContent = '继续当前牌局';
    cancel.onclick = () => { G.showStart = false; refreshStart(); draw(); };
    G.startCancel = cancel;

    inner.append(title, sub, wait, row, cancel);
    el.appendChild(inner);
    return el;
  }

  function refreshStart() {
    const el = G.startEl;
    if (!el) return;
    const st = G.state;
    const spec = isSpectator();
    const notStarted = !st || !st.started;
    const need = notStarted || G.showStart;
    el.style.display = need ? 'flex' : 'none';
    if (!need) return;

    const forceWait = spec; // 观战者永远不能选难度
    if (G.startWait) G.startWait.style.display = forceWait ? 'block' : 'none';
    if (G.startRow) G.startRow.style.display = forceWait ? 'none' : 'flex';
    if (G.startCancel) G.startCancel.style.display = (!notStarted && !spec) ? 'inline-block' : 'none';
    if (G.startTitle) G.startTitle.textContent = forceWait ? '观战席' : (notStarted ? '选择难度' : '开始新游戏');
    const sub = el.querySelector('.spider-start-sub');
    if (sub) sub.textContent = forceWait ? '房主选择难度后将自动开始' : '花色越多挑战越大';
  }

  /* ============================== 工具条 ============================== */
  function updateUI() {
    const s = G.state;
    const spec = isSpectator();
    if (G.diffPill) {
      if (s && s.started) {
        const d = DIFFS.find(x => x.suits === s.suitCount) || DIFFS[0];
        G.diffPill.textContent = d.name + ' · ' + d.sub;
        G.diffPill.style.setProperty('--dc', d.color);
      } else {
        G.diffPill.textContent = '未开局';
      }
    }
    if (G.statusEl) {
      if (!s || !s.started) G.statusEl.textContent = spec ? '观战中' : '请选择难度';
      else if (s.won) G.statusEl.textContent = '\uD83C\uDF89 通关!' + (spec ? '(观战)' : '');
      else {
        const d = DIFFS.find(x => x.suits === s.suitCount) || DIFFS[0];
        G.statusEl.textContent = '\uD83C\uDFC6 ' + s.score + ' · \uD83D\uDC63 ' + s.moves
          + ' · \uD83D\uDCC1 ' + s.foundations.length + '/' + (s.totalSets || 8)
          + (spec ? ' · \uD83D\uDC41 观战中' : '');
        void d;
      }
    }
    if (G.newBtn) G.newBtn.disabled = spec;
    if (G.dealBtn) {
      G.dealBtn.disabled = spec || !s || !s.started || s.won || s.stock === 0 || hasEmptyColumn(s);
      G.dealBtn.textContent = (s && s.started) ? '发牌 (' + s.dealsLeft + ')' : '发牌';
      G.dealBtn.title = hasEmptyColumn(s) ? '有空列时不能发牌' : '从牌堆给每列发一张';
    }
    if (G.undoBtn) G.undoBtn.disabled = spec || !s || !s.started || !s.canUndo;
  }

  function applyState(s) {
    const prev = G.state;
    G.state = s;
    G.sel = null;
    G.drag = null;
    if (G.geom) G.geom.targetCol = -1;
    if (!s || !s.started) {
      G.pos = new Map();
      G.confetti = null;
      G.showStart = false;
    } else if (!prev || !prev.started || prev.gameSeq !== s.gameSeq) {
      G.pos = new Map();          // 新局:清空位置,触发从牌堆发牌动画
      G.confetti = null;
      G.showStart = false;
    }
    if (s && s.started && (!prev || !prev.won) && s.won) spawnConfetti();
    draw();
    updateUI();
    refreshStart();
  }

  function onResize() {
    if (!G.cv) return;
    baseLayout();
    draw();
  }

  /* ============================== 挂载 =============================== */
  window.HallGames.spider = {
    mount(container, api) {
      G.api = api;
      G.container = container;
      G.state = api.snapshot || null;
      G.pos = new Map();
      G.confetti = null;

      container.innerHTML = '';
      const root = document.createElement('div');
      root.className = 'spider';
      G.root = root;

      const bar = document.createElement('div');
      bar.className = 'spider-bar';
      G.bar = bar;

      const pill = document.createElement('span');
      pill.className = 'spider-pill';
      pill.textContent = '未开局';
      G.diffPill = pill;

      const newBtn = document.createElement('button');
      newBtn.className = 'spider-btn';
      newBtn.textContent = '新游戏';
      newBtn.onclick = () => { G.showStart = true; refreshStart(); };
      G.newBtn = newBtn;

      const dealBtn = document.createElement('button');
      dealBtn.className = 'spider-btn';
      dealBtn.textContent = '发牌';
      dealBtn.onclick = () => G.api.send({ a: 'deal' });
      G.dealBtn = dealBtn;

      const undoBtn = document.createElement('button');
      undoBtn.className = 'spider-btn ghost';
      undoBtn.textContent = '撤销';
      undoBtn.onclick = () => G.api.send({ a: 'undo' });
      G.undoBtn = undoBtn;

      const status = document.createElement('span');
      status.className = 'spider-status';
      G.statusEl = status;

      bar.append(pill, newBtn, dealBtn, undoBtn, status);

      const stage = document.createElement('div');
      stage.className = 'spider-stage';
      G.stage = stage;

      const cv = document.createElement('canvas');
      cv.className = 'spider-cv';
      cv.addEventListener('pointerdown', onDown);
      cv.addEventListener('pointermove', onMove);
      cv.addEventListener('pointerup', onUp);
      cv.addEventListener('pointercancel', onCancel);
      cv.addEventListener('contextmenu', e => e.preventDefault());
      G.cv = cv;
      G.ctx = cv.getContext('2d');

      G.startEl = buildStartPanel();

      stage.append(cv, G.startEl);
      root.append(bar, stage);
      container.appendChild(root);

      G._onResize = onResize;
      window.addEventListener('resize', onResize);
      if (window.ResizeObserver) {
        // 放到下一帧执行,避免 resize 回环告警
        G._ro = new ResizeObserver(() => {
          if (G._rafResize) return;
          G._rafResize = requestAnimationFrame(() => { G._rafResize = null; onResize(); });
        });
        G._ro.observe(stage);
      }
      onResize();
      applyState(G.state);
    },

    unmount() {
      if (G._onResize) window.removeEventListener('resize', G._onResize);
      G._onResize = null;
      if (G._rafResize) { try { cancelAnimationFrame(G._rafResize); } catch (e) {} G._rafResize = null; }
      if (G._ro) { try { G._ro.disconnect(); } catch (e) {} G._ro = null; }
      if (G.raf) { try { cancelAnimationFrame(G.raf); } catch (e) {} G.raf = null; }
      G.cv = null; G.ctx = null; G.container = null; G.root = null;
      G.bar = null; G.stage = null; G.statusEl = null; G.dealBtn = null;
      G.undoBtn = null; G.newBtn = null; G.diffPill = null;
      G.startEl = null; G.startRow = null; G.startWait = null; G.startCancel = null;
      G.drag = null; G.sel = null; G.pos = null; G.confetti = null;
    },

    onSnapshot(s) { applyState(s); },
    onMessage(m) { if (m && m.a === 'state') applyState(m); },
    onRoom() { draw(); updateUI(); refreshStart(); },
  };
})();
