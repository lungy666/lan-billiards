/*
 * hall/games/spider/server.js —— 蜘蛛纸牌(进程内游戏模块 · 服务端权威)
 *
 * 单机游戏:maxPlayers = 1(多出来的自动观战)。所有牌面由服务器生成、校验并
 * 广播,因此:
 *   - 观战者能看到实时牌局;
 *   - 中途进入 / 断线重连能用 snapshot 还原;
 *   - 未翻开的暗牌只下发张数,不下发点数/花色,避免"翻包看牌"。
 *
 * 规则(经典蜘蛛):
 *   - 双副牌 104 张(1 花色=8 套 / 2 花色=各 4 套 / 4 花色=各 2 套);
 *   - 10 列,前 4 列 6 张、后 6 列 5 张,仅顶张亮牌;余 50 张进入牌堆;
 *   - 可移动"同花色的连续降序牌组"(K→A);
 *   - 任意牌都可压到比自己大一点的牌上(花色不限);
 *   - 牌堆每次给每列发 1 张亮牌;有空列时不能发牌;
 *   - 凑齐 K→A 同花色即自动收走,收满 8 组获胜;
 *   - 支持撤销。
 */
'use strict';

const COLS = 10;
const TOTAL_SETS = 8;

/* ------------------------------------------------------------------ */
/* 建牌 / 发牌                                                          */
/* ------------------------------------------------------------------ */

function buildDeck(suitCount) {
  const suits = [];
  for (let i = 0; i < suitCount; i++) suits.push(i);
  const copies = TOTAL_SETS / suitCount; // 8 / 4 / 2
  const deck = [];
  let id = 0;
  for (const s of suits) {
    for (let c = 0; c < copies; c++) {
      for (let r = 1; r <= 13; r++) deck.push({ id: id++, s, r, u: false });
    }
  }
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function newGame(suitCount) {
  const deck = shuffle(buildDeck(suitCount));
  const columns = [];
  let k = 0;
  for (let i = 0; i < COLS; i++) {
    const n = i < 4 ? 6 : 5;
    const col = [];
    for (let j = 0; j < n; j++) col.push(deck[k++]);
    col[col.length - 1].u = true; // 仅顶张亮牌
    columns.push(col);
  }
  return {
    started: true,
    suitCount,
    columns,
    stock: deck.slice(k),      // 余 50 张
    foundations: [],           // 已收走的整套(存花色,用于展示)
    moves: 0,
    score: 500,
    won: false,
    history: [],               // 撤销栈
  };
}

/* ------------------------------------------------------------------ */
/* 规则                                                                 */
/* ------------------------------------------------------------------ */

// col[idx..] 是否是一段亮着的、同花色的连续降序牌组(可整体端起)
function runStart(col, idx) {
  if (idx < 0 || idx >= col.length) return false;
  if (!col[idx].u) return false;
  for (let i = idx; i < col.length - 1; i++) {
    const a = col[i], b = col[i + 1];
    if (!b.u || a.s !== b.s || a.r !== b.r + 1) return false;
  }
  return true;
}

// 能否把 card 放到 target 列(空列任意,否则需比顶牌小 1)
function canPlace(card, target) {
  if (!target.length) return true;
  const top = target[target.length - 1];
  return !!top.u && top.r === card.r + 1;
}

function cloneCards(cards) {
  return cards.map(c => ({ id: c.id, s: c.s, r: c.r, u: c.u }));
}

function saveHistory(s) {
  s.history.push({
    columns: s.columns.map(cloneCards),
    stock: cloneCards(s.stock),
    foundations: s.foundations.slice(),
    moves: s.moves,
    score: s.score,
    won: s.won,
  });
  if (s.history.length > 300) s.history.shift();
}

// 检查并收走所有已完成的 K→A 同花色牌组
function checkFoundations(s) {
  for (let c = 0; c < COLS; c++) {
    let again = true;
    while (again) {
      again = false;
      const col = s.columns[c];
      if (col.length < 13) break;
      const base = col.length - 13;
      const first = col[base];
      if (!first.u) break;
      let ok = true;
      for (let i = 0; i < 13; i++) {
        const card = col[base + i];
        if (!card.u || card.s !== first.s || card.r !== 13 - i) { ok = false; break; }
      }
      if (!ok) break;
      col.splice(base, 13);
      s.foundations.push(first.s);
      s.score += 100;
      if (col.length && !col[col.length - 1].u) col[col.length - 1].u = true;
      again = true;
    }
  }
  if (s.foundations.length >= TOTAL_SETS) {
    s.foundations.length = TOTAL_SETS;
    s.won = true;
  }
}

function doMove(s, from, index, to) {
  if (s.won) return false;
  if (from === to || from < 0 || from >= COLS || to < 0 || to >= COLS) return false;
  const src = s.columns[from], dst = s.columns[to];
  if (!src || !dst) return false;
  if (!runStart(src, index)) return false;
  if (!canPlace(src[index], dst)) return false;

  saveHistory(s);
  const run = src.splice(index);
  for (const card of run) dst.push(card);
  if (src.length && !src[src.length - 1].u) src[src.length - 1].u = true;
  s.moves++;
  s.score = Math.max(0, s.score - 1);
  checkFoundations(s);
  return true;
}

function doDeal(s) {
  if (s.won) return false;
  if (!s.stock.length) return false;
  if (s.columns.some(c => c.length === 0)) return false; // 有空列不能发牌
  saveHistory(s);
  for (let i = 0; i < COLS; i++) {
    const card = s.stock.shift();
    card.u = true;
    s.columns[i].push(card);
  }
  s.moves++;
  s.score = Math.max(0, s.score - 1);
  checkFoundations(s);
  return true;
}

function doUndo(s) {
  if (!s.history.length) return false;
  const h = s.history.pop();
  s.columns = h.columns;
  s.stock = h.stock;
  s.foundations = h.foundations;
  s.moves = h.moves;
  s.score = h.score;
  s.won = h.won;
  return true;
}

/* ------------------------------------------------------------------ */
/* 对外状态(裁掉暗牌信息)                                              */
/* ------------------------------------------------------------------ */

function maskCard(c) {
  return c.u ? { id: c.id, u: 1, s: c.s, r: c.r } : { id: c.id, u: 0 };
}

function stateOf(ctx) {
  const s = ctx.state;
  if (!s || !s.started) {
    return { a: 'state', started: false, suitCount: s ? s.suitCount : 1, gameSeq: s ? s.gameSeq : 0 };
  }
  return {
    a: 'state',
    started: true,
    gameSeq: s.gameSeq,
    suitCount: s.suitCount,
    columns: s.columns.map(col => col.map(maskCard)),
    stock: s.stock.length,
    dealsLeft: Math.floor(s.stock.length / COLS),
    foundations: s.foundations.slice(),
    totalSets: TOTAL_SETS,
    moves: s.moves,
    score: s.score,
    won: s.won,
    canUndo: s.history.length > 0,
  };
}

function push(ctx) {
  ctx.broadcast(stateOf(ctx));
}

function startGame(ctx, suitCount) {
  const seq = ((ctx.state && ctx.state.gameSeq) || 0) + 1;
  ctx.state = newGame(suitCount);
  ctx.state.gameSeq = seq;
  ctx.setPhase('playing');
}

/* ------------------------------------------------------------------ */
/* GameModule 接口                                                      */
/* ------------------------------------------------------------------ */

function isSeated(player) {
  return player && player.seat !== null && player.seat !== undefined;
}

module.exports = {
  id: 'spider',
  name: '蜘蛛纸牌',
  minPlayers: 1,
  maxPlayers: 1,
  allowSpectators: true,
  tickHz: 0,                     // 纯回合制,无需定时模拟

  createState(ctx) {
    ctx.state = {
      started: false,
      gameSeq: 0,
      suitCount: 1,
      columns: [],
      stock: [],
      foundations: [],
      moves: 0,
      score: 500,
      won: false,
      history: [],
    };
    ctx.setPhase('waiting');
  },

  // 入座后由玩家在客户端选择难度(服务器不自动开局);观战者进入只推送快照
  onJoin(ctx) {
    push(ctx);
  },

  onLeave(ctx) {
    push(ctx);
  },

  onMessage(ctx, player, m) {
    if (!m || typeof m !== 'object') return;
    const s = ctx.state;

    // 只有坐在座位上的玩家能操作,观战者只读
    if (m.a === 'new') {
      if (!isSeated(player)) return;
      const suits = [1, 2, 4].includes(m.suits | 0) ? (m.suits | 0) : 1;
      startGame(ctx, suits);
      push(ctx);
      return;
    }

    if (!s.started || !isSeated(player)) return;

    let changed = false;
    if (m.a === 'move') changed = doMove(s, m.from | 0, m.index | 0, m.to | 0);
    else if (m.a === 'deal') changed = doDeal(s);
    else if (m.a === 'undo') changed = doUndo(s);

    if (changed) {
      ctx.setPhase(s.won ? 'finished' : 'playing');
      push(ctx);
    }
  },

  snapshot(ctx) {
    return stateOf(ctx);
  },
};
