/*
 * physics.js —— 台球物理共享模块(服务端 Node 与浏览器通用)
 * 世界坐标:球台内沿 x ∈ [0, 1000],y ∈ [0, 500]
 * 球对象:{ id, x, y, vx, vy, wx, wy, wz, potted }
 *   (wx, wy) 绕水平轴自旋:决定滑动/滚动状态(跟杆、拉杆由此产生)
 *   (wz)     绕竖轴自旋:左右塞(影响撞库反弹与自旋传递)
 *
 * 物理模型(依据 Han 2005 事件式台球模拟 / Alciatore 球间摩擦 throw 论文):
 *   1. 三相运动:滑动(摩擦线性减速+旋进自然滚动)、滚动(滚动阻力)、竖轴旋转(原地旋转衰减)
 *   2. 球-球碰撞:法向冲量(恢复系数)+ 切向库仑摩擦冲量(throw 偏转与自旋传递,上限 μ·Jn)
 *   3. 库边碰撞:法向恢复系数 + 切向摩擦冲量(咬塞:侧塞改变反弹角,同时衰减侧旋)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Billiards = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 1000, H = 500, R = 11.2;

  // 袋口:中心 + 捕获半径(中心略微位于台面之外)
  // 开口宽度必须让球在触及颊壁(库边断口)前先进入捕获圈,否则会被直角反弹弹回
  const CORNER_C = 9, CORNER_R = 28, CORNER_GAP = 20;
  const SIDE_C = 10, SIDE_R = 27, SIDE_GAP = 18;
  const POCKETS = [
    { x: -CORNER_C,      y: -CORNER_C,      r: CORNER_R },
    { x: W / 2,          y: -SIDE_C,        r: SIDE_R },
    { x: W + CORNER_C,   y: -CORNER_C,      r: CORNER_R },
    { x: -CORNER_C,      y: H + CORNER_C,   r: CORNER_R },
    { x: W / 2,          y: H + SIDE_C,     r: SIDE_R },
    { x: W + CORNER_C,   y: H + CORNER_C,   r: CORNER_R },
  ];

  // 库边开口:位于开口内的球越过库边线时不反弹(袋口区域)
  function inGapX(x) { return x < CORNER_GAP || x > W - CORNER_GAP || Math.abs(x - W / 2) < SIDE_GAP; }
  function inGapY(y) { return y < CORNER_GAP || y > H - CORNER_GAP; }

  // —— 物理常数(1m ≈ 393.7 世界单位,桌面 1000u = 2.54m,g ≈ 3861 u/s²)——
  const G_U = 3861;
  const MU_SLIDE = 0.20;        // 呢面滑动摩擦系数(真实 0.15~0.25)
  const MU_ROLL = 0.038;        // 滚动阻力系数(旧呢面 0.03~0.04)
  const MU_SPIN = 0.044;        // 竖轴旋转摩擦系数
  const SLIDE_A = MU_SLIDE * G_U;             // 滑动减速度 ≈ 772 u/s²
  const ROLL_A = MU_ROLL * G_U;               // 滚动减速度 ≈ 147 u/s²
  const SPIN_DEC = 5 * MU_SPIN * G_U / (2 * R); // 竖轴旋转角加速度(原地旋转衰减)
  const BALL_E = 0.94;          // 球-球法向恢复系数
  const MU_BALL = 0.06;         // 球-球摩擦系数(throw 效应,真实 0.05~0.06)
  const CUSHION_E = 0.85;       // 库边法向恢复系数
  const MU_CUSHION = 0.20;      // 库边摩擦系数(咬塞强度)
  const ROLL_SNAP = 12;         // 滑移速度低于该值视为进入纯滚动
  const STOP_V = 8, STOP_W = 0.6;
  const SUB = 4;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function ballType(n) { return n === 8 ? 'eight' : n < 8 ? 'solid' : 'stripe'; }

  // 标准黑八摆球:8 号在第三排中间,底排两角一全一花
  function rack() {
    const balls = [{ id: 0, x: W * 0.17, y: H / 2, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, potted: false }];
    const dx = 2 * R * 0.866 + 0.55, dy = 2 * R + 0.55;
    const ax = W * 0.75, ay = H / 2;
    const solids = shuffle([1, 2, 3, 4, 5, 6, 7]);
    const stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
    const order = new Array(15).fill(0);
    order[4] = 8;
    if (Math.random() < 0.5) { order[10] = solids.pop(); order[14] = stripes.pop(); }
    else { order[10] = stripes.pop(); order[14] = solids.pop(); }
    const rest = shuffle(solids.concat(stripes));
    for (let i = 0; i < 15; i++) if (!order[i]) order[i] = rest.pop();
    let k = 0;
    for (let row = 0; row < 5; row++) {
      for (let j = 0; j <= row; j++) {
        balls.push({ id: order[k], x: ax + row * dx, y: ay + (j - row / 2) * dy, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, potted: false });
        k++;
      }
    }
    return balls;
  }

  /* ---- 击球:瞄准角 angle、力度 power(0~1)、击球点偏移 a(左右塞) / b(高低杆,以 R 计) ---- */
  function strike(cue, angle, power, a, b) {
    const v0 = 180 + 1420 * clamp(power, 0, 1);
    const dx = Math.cos(angle), dy = Math.sin(angle);
    cue.vx = dx * v0;
    cue.vy = dy * v0;
    cue.wx = 0; cue.wy = 0; cue.wz = 0;
    a = clamp(a || 0, -0.55, 0.55);
    b = clamp(b || 0, -0.55, 0.55);
    // 高低杆:自旋/速度比 = 2.5·b(b=0.4R 时恰为自然滚动;>1 跟杆强,<0 拉杆)
    const ratio = clamp(2.5 * b, -1.4, 1.4);
    cue.wx = ratio * (v0 / R) * (-dy);
    cue.wy = ratio * (v0 / R) * (dx);
    // The tip offset is along (-dy, dx); r cross impulse gives negative wz for right english.
    cue.wz = -2.5 * a * (v0 / R);
    return cue;
  }

  /* ---- 球-球碰撞:法向冲量 + 切向摩擦(throw 偏转 + 自旋传递) ---- */
  function resolveBallBall(a, b, ev) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d2 = dx * dx + dy * dy, min = 2 * R;
    if (d2 >= min * min || d2 === 0) return;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    const overlap = min - d;
    a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
    b.x += nx * overlap / 2; b.y += ny * overlap / 2;
    const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;
    const jn = -(1 + BALL_E) * vn / 2;               // 等质量法向冲量(Δv 单位)
    // 接触点切向相对滑移(含两球竖轴自旋的表面线速度)
    let tx = rvx - vn * nx + R * (a.wz + b.wz) * ny;
    let ty = rvy - vn * ny - R * (a.wz + b.wz) * nx;
    const ts = Math.hypot(tx, ty);
    let jtx = 0, jty = 0;
    if (ts > 1e-6) {
      const jt = Math.min(MU_BALL * jn, ts / 7); // Two equal solid spheres share the tangential impulse.
      jtx = -jt * tx / ts; jty = -jt * ty / ts;
    }
    b.vx += jn * nx + jtx; b.vy += jn * ny + jty;    // 冲量作用在 B
    a.vx -= jn * nx + jtx; a.vy -= jn * ny + jty;    // 反作用在 A
    // 竖轴自旋变化:Δωz = (5/2R)·(r × p)_z(A、B 各自的接触偏移与冲量)
    const dwz = (5 / (2 * R)) * (ny * jtx - nx * jty);
    b.wz += dwz;
    a.wz += dwz;
    ev.push({ k: 'hit', a: a.id, b: b.id, sp: -vn, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }

  /* ---- 库边碰撞:法向恢复 + 切向摩擦(侧塞咬库改变反弹角并衰减侧旋) ---- */
  // n = (nx, ny):指向台面内侧的单位法向;(tx0, ty0) = (-ny, nx) 为切向
  function resolveCushion(b, nx, ny, ev) {
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;
    const tx0 = -ny, ty0 = nx;
    const vt = b.vx * tx0 + b.vy * ty0 - b.wz * R;
    const Jn = -(1 + CUSHION_E) * vn;
    let jt = 0;
    if (Math.abs(vt) > 1e-6) jt = -Math.sign(vt) * Math.min(MU_CUSHION * Jn, Math.abs(vt) * 2 / 7);
    b.vx += Jn * nx + jt * tx0;
    b.vy += Jn * ny + jt * ty0;
    b.wz += -(5 / (2 * R)) * jt;
    ev.push({ k: 'rail', sp: -vn, x: b.x, y: b.y });
  }

  // 推进一帧(dt 为帧时长,内部再细分),返回事件数组
  function step(balls, dt) {
    const ev = [];
    const maxSpeed = Math.max(0, ...balls.filter(b => !b.potted).map(b => Math.hypot(b.vx, b.vy)));
    const subdivisions = Math.max(SUB, Math.ceil(maxSpeed * dt / 0.75));
    const sub = dt / subdivisions;
    for (let s = 0; s < subdivisions; s++) {
      // —— 三相运动:滑动 / 滚动+旋转 ——
      for (const b of balls) {
        if (b.potted) continue;
        const ux = b.vx - b.wy * R;
        const uy = b.vy + b.wx * R;
        const us = Math.hypot(ux, uy);
        if (us > ROLL_SNAP) {
          // 滑动相:线性减速 + 摩擦力矩旋进自然滚动(竖轴旋转不受水平摩擦影响)
          const inv = 1 / us;
          const nx = ux * inv, ny = uy * inv;
          const impulse = Math.min(SLIDE_A * sub, us * 2 / 7);
          b.vx -= impulse * nx;
          b.vy -= impulse * ny;
          b.wx -= (5 / (2 * R)) * ny * impulse;
          b.wy += (5 / (2 * R)) * nx * impulse;
        } else {
          // 滚动相:滚动阻力线性减速,水平自旋锁定为自然滚动
          const vs = Math.hypot(b.vx, b.vy);
          if (vs > STOP_V) {
            const k = Math.max(0, 1 - (ROLL_A * sub) / vs);
            b.vx *= k; b.vy *= k;
            b.wx = -b.vy / R; b.wy = b.vx / R;
          } else if (vs > 0 || b.wx !== 0 || b.wy !== 0) {
            b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0;
          }
        }
        // 竖轴旋转衰减(原地旋转的球不会平移,只会停转)
        if (Math.abs(b.wz) > STOP_W) b.wz -= Math.sign(b.wz) * Math.min(Math.abs(b.wz), SPIN_DEC * sub);
        else if (b.wz !== 0) b.wz = 0;
        b.x += b.vx * sub;
        b.y += b.vy * sub;
      }
      // —— 球-球碰撞(throw + 自旋传递)——
      for (let i = 0; i < balls.length; i++) {
        const a = balls[i]; if (a.potted) continue;
        for (let j = i + 1; j < balls.length; j++) {
          const c = balls[j]; if (c.potted) continue;
          resolveBallBall(a, c, ev);
        }
      }
      // —— 库边(袋口开口处不反弹)——
      for (const b of balls) {
        if (b.potted) continue;
        if (b.x < R && b.vx < 0 && !inGapY(b.y)) {
          const sp = b.vx; b.x = R; resolveCushion(b, 1, 0, ev);
          ev[ev.length - 1].sp = sp;
        } else if (b.x > W - R && b.vx > 0 && !inGapY(b.y)) {
          const sp = b.vx; b.x = W - R; resolveCushion(b, -1, 0, ev);
          ev[ev.length - 1].sp = sp;
        }
        if (b.y < R && b.vy < 0 && !inGapX(b.x)) {
          const sp = b.vy; b.y = R; resolveCushion(b, 0, 1, ev);
          ev[ev.length - 1].sp = sp;
        } else if (b.y > H - R && b.vy > 0 && !inGapX(b.x)) {
          const sp = b.vy; b.y = H - R; resolveCushion(b, 0, -1, ev);
          ev[ev.length - 1].sp = sp;
        }
      }
      // —— 袋口捕获 ——
      for (const b of balls) {
        if (b.potted) continue;
        for (const p of POCKETS) {
          const dx = b.x - p.x, dy = b.y - p.y;
          if (dx * dx + dy * dy < p.r * p.r) {
            const spd = Math.hypot(b.vx, b.vy);
            b.potted = true; b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0;
            ev.push({ k: 'pot', id: b.id, x: p.x, y: p.y, sp: spd });
            break;
          }
        }
      }
      // —— 兜底:越过库边很远的球算落入最近袋 ——
      for (const b of balls) {
        if (b.potted) continue;
        if (b.x < -R - 2 || b.x > W + R + 2 || b.y < -R - 2 || b.y > H + R + 2) {
          let best = POCKETS[0], bd = Infinity;
          for (const p of POCKETS) {
            const d2 = (b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y);
            if (d2 < bd) { bd = d2; best = p; }
          }
          b.potted = true; b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0;
          ev.push({ k: 'pot', id: b.id, x: best.x, y: best.y, sp: 0 });
        }
      }
    }
    return ev;
  }

  function allStopped(balls) {
    for (const b of balls) {
      if (b.potted) continue;
      if (b.vx !== 0 || b.vy !== 0 || b.wx !== 0 || b.wy !== 0 || b.wz !== 0) return false;
    }
    return true;
  }

  // Preview uses the same initial state, timestep and solver as the server.
  function predict(balls, angle, power, off, frames = 360) {
    const copy = balls.filter(Boolean).map(b => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
    const cue = copy.find(b => b.id === 0);
    if (!cue || cue.potted) return [];
    strike(cue, angle, power, off[0], off[1]);
    const paths = new Map(copy.filter(b => !b.potted).map(b => [b.id, { id: b.id, points: [[b.x, b.y]] }]));
    for (let i = 0; i < frames; i++) {
      step(copy, 1 / 60);
      for (const b of copy) {
        const path = paths.get(b.id);
        if (!path || b.potted) continue;
        const last = path.points[path.points.length - 1];
        if (Math.hypot(b.x - last[0], b.y - last[1]) > 1) path.points.push([b.x, b.y]);
      }
      if (allStopped(copy)) break;
    }
    return Array.from(paths.values()).filter(p => p.points.length > 1);
  }

  // 自由球摆放校验:台面内且不与任何球重叠
  function validPlace(balls, x, y) {
    if (!(x >= R + 1 && x <= W - R - 1 && y >= R + 1 && y <= H - R - 1)) return false;
    for (const b of balls) {
      if (b.potted || b.id === 0) continue;
      const dx = b.x - x, dy = b.y - y;
      if (dx * dx + dy * dy < (2 * R + 0.5) * (2 * R + 0.5)) return false;
    }
    return true;
  }

  // 重新放置某球(开球黑八落袋):优先置球点,向两侧找空位
  function respot(balls, id) {
    const b = balls.find(b => b.id === id);
    if (!b) return;
    const y = H / 2;
    for (let d = 0; d < W; d += 4) {
      if (validPlace(balls, W * 0.75 + d, y)) { b.x = W * 0.75 + d; b.y = y; b.wx = 0; b.wy = 0; b.wz = 0; return; }
      if (validPlace(balls, W * 0.75 - d, y)) { b.x = W * 0.75 - d; b.y = y; b.wx = 0; b.wy = 0; b.wz = 0; return; }
    }
  }

  function groupCleared(balls, g) {
    return !balls.some(b => !b.potted && b.id > 0 && ballType(b.id) === g);
  }

  return {
    W, H, R, POCKETS, CORNER_GAP, SIDE_GAP,
    rack, step, predict, allStopped, validPlace, respot, strike, ballType, groupCleared,
    PARAMS: {
      MU_SLIDE, MU_ROLL, MU_SPIN, MU_BALL, CUSHION_E, MU_CUSHION,
      SLIDE_A, ROLL_A, BALL_E,
    },
  };
});
