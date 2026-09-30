/*
 * hall/adapters/inprocess.js —— 进程内游戏适配器
 *
 * 加载实现了 GameModule 接口的模块,并为它构造受控上下文 ctx。
 * 游戏只能通过 ctx 观察/影响房间,不能触碰大厅内部状态。
 */
'use strict';
const path = require('path');

class InProcessAdapter {
  constructor(room, def) {
    this.room = room;
    this.def = def;
    this.game = require(path.join(__dirname, '..', 'games', def.entry));
    if (!this.game || typeof this.game !== 'object') {
      throw new Error(`game module ${def.id} is invalid`);
    }
    this.ctx = makeCtx(room);
    this.timer = null;
  }

  start() {
    if (this.game.createState) this.game.createState(this.ctx);
    const hz = +this.game.tickHz || 0;
    if (hz > 0) {
      const dt = 1 / hz;
      this.timer = setInterval(() => {
        if (this.room.destroyed) return;
        try { this.game.tick(this.ctx, dt); }
        catch (e) { console.error(`[game:${this.def.id}] tick error`, e); }
      }, Math.round(1000 / hz));
    }
  }

  onJoin(player) { if (this.game.onJoin) this.game.onJoin(this.ctx, player); }
  onLeave(player) { if (this.game.onLeave) this.game.onLeave(this.ctx, player); }
  onMessage(player, msg) { if (this.game.onMessage) this.game.onMessage(this.ctx, player, msg); }
  snapshot() { return this.game.snapshot ? this.game.snapshot(this.ctx) : null; }

  // 前端接入信息:内联模式,由大厅提供脚本,共用大厅 WebSocket
  entry() {
    return {
      mode: 'inline',
      key: this.def.id,
      script: `/games/${this.def.id}/client.js`,
      ready: true,
    };
  }

  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { if (this.game.dispose) this.game.dispose(this.ctx); }
    catch (e) { console.error(`[game:${this.def.id}] dispose error`, e); }
  }
}

/* ---------------- 受控上下文 ctx ---------------- */
function makeCtx(room) {
  return {
    get id() { return room.id; },
    get gameId() { return room.def.id; },
    get phase() { return room.phase; },
    state: null,                         // 游戏私有状态,随房间生命周期存活

    get seats() { return room.seatList(); },
    get spectators() { return room.spectatorList(); },

    setPhase(p) { room.setPhase(p); },
    broadcast(obj, except) { room.sendGame(obj, except); },
    toSeat(seat, obj) { room.sendGameToSeat(seat, obj); },
    toSpectators(obj) { room.sendGameToSpectators(obj); },
    send(player, obj) { room.sendGameToPlayer(player, obj); },
    log(text) { room.broadcast({ t: 'msg', text }); },

    now() { return Date.now(); },
  };
}

module.exports = InProcessAdapter;
