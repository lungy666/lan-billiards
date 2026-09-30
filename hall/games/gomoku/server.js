/*
 * hall/games/gomoku/server.js —— 五子棋(进程内游戏模块,GameModule 参考实现)
 *
 * 该模块演示了接入大厅所需的全部接口:
 *   createState / onJoin / onLeave / onMessage / snapshot
 * 全部逻辑通过 ctx 完成,不依赖大厅内部实现。
 */
'use strict';

const SIZE = 15;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

function emptyBoard() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

function seatedCount(ctx) {
  let n = 0;
  for (const s of ctx.seats) if (s) n++;
  return n;
}

function checkWin(board, x, y, p) {
  for (const [dx, dy] of DIRS) {
    let n = 1;
    for (const sgn of [1, -1]) {
      let cx = x + dx * sgn, cy = y + dy * sgn;
      while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy][cx] === p) {
        n++; cx += dx * sgn; cy += dy * sgn;
      }
    }
    if (n >= 5) return true;
  }
  return false;
}

function stateOf(ctx) {
  const s = ctx.state;
  if (!s) return { a: 'state', size: SIZE, board: emptyBoard(), turn: 1, winner: 0, last: null, moveCount: 0, started: false, rematch: [false, false], seats: ctx.seats.map(p => (p ? { name: p.name, admin: p.admin } : null)) };
  return {
    a: 'state',
    size: s.size,
    board: s.board,
    turn: s.turn,
    winner: s.winner,
    last: s.last,
    moveCount: s.moves.length,
    started: s.started,
    rematch: s.rematch,
    seats: ctx.seats.map(p => (p ? { name: p.name, admin: p.admin } : null)),
  };
}

function push(ctx) {
  ctx.broadcast(stateOf(ctx));
}

function startGame(ctx) {
  const s = ctx.state;
  s.board = emptyBoard();
  s.turn = 1;
  s.winner = 0;
  s.last = null;
  s.moves = [];
  s.started = true;
  s.rematch = [false, false];
  ctx.setPhase('playing');
}

module.exports = {
  id: 'gomoku',
  name: '五子棋',
  minPlayers: 2,
  maxPlayers: 2,
  allowSpectators: true,
  tickHz: 0,                      // 回合制,无需定时模拟

  createState(ctx) {
    ctx.state = {
      size: SIZE,
      board: emptyBoard(),
      turn: 1,
      winner: 0,
      last: null,
      moves: [],
      started: false,
      rematch: [false, false],
    };
    ctx.setPhase('waiting');
  },

  onJoin(ctx) {
    const s = ctx.state;
    if (!s.started && seatedCount(ctx) === 2) startGame(ctx);
    push(ctx);
  },

  onLeave(ctx) {
    const s = ctx.state;
    const n = seatedCount(ctx);
    if (s.started && n < 2) {
      s.started = false;
      if (n === 1) {
        const seat = ctx.seats.findIndex(Boolean);
        s.winner = seat + 1;
        ctx.setPhase('finished');
      } else {
        s.winner = 0;
        ctx.setPhase('waiting');
      }
    }
    push(ctx);
  },

  onMessage(ctx, player, m) {
    if (!m || typeof m !== 'object') return;
    const s = ctx.state;

    if (m.a === 'place') {
      if (ctx.phase !== 'playing' || s.winner || player.seat === null) return;
      if (player.seat + 1 !== s.turn) return;
      const x = m.x | 0, y = m.y | 0;
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
      if (s.board[y][x] !== 0) return;

      s.board[y][x] = s.turn;
      s.moves.push([x, y, s.turn]);
      s.last = [x, y];

      if (checkWin(s.board, x, y, s.turn)) {
        s.winner = s.turn;
        s.started = false;
        ctx.setPhase('finished');
      } else if (s.moves.length >= SIZE * SIZE) {
        s.winner = 3;             // 平局
        s.started = false;
        ctx.setPhase('finished');
      } else {
        s.turn = 3 - s.turn;      // 1 <-> 2
      }
      push(ctx);
      return;
    }

    if (m.a === 'rematch') {
      if (ctx.phase !== 'finished' || player.seat === null) return;
      s.rematch[player.seat] = true;
      if (s.rematch[0] && s.rematch[1]) startGame(ctx);
      else ctx.log(`${player.name} 想再来一局,等待对方同意…`);
      push(ctx);
      return;
    }

    if (m.a === 'reset' && player.admin) {
      startGame(ctx);
      push(ctx);
    }
  },

  snapshot(ctx) {
    return stateOf(ctx);
  },
};
