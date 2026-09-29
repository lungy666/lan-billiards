/*
 * hall/room.js —— 房间:座位 / 观战 / 生命周期 / 消息转发
 *
 * 房间本身不含任何游戏规则,全部交给 adapter(进程内模块或外部进程)。
 */
'use strict';
const { createAdapter } = require('./adapters');

class Room {
  constructor(lobby, id, def) {
    this.lobby = lobby;
    this.id = id;
    this.def = def;
    this.gameId = def.id;
    this.phase = 'waiting';               // waiting | playing | finished
    this.maxPlayers = def.maxPlayers || 2;
    this.seats = new Array(this.maxPlayers).fill(null); // null 或 connection
    this.spectators = new Set();          // connection 集合
    this.createdAt = Date.now();
    this.destroyed = false;
    this.ready = def.mode !== 'external'; // 外部游戏需等待进程就绪

    this.adapter = createAdapter(this, def);
    // 进程内游戏在此同步完成 createState,后续 join 即可用;
    // 外部进程的 start() 是异步的,自行处理就绪/失败。
    try {
      const ret = this.adapter.start();
      if (ret && typeof ret.catch === 'function') {
        ret.catch(e => console.error(`[room:${id}] adapter start failed`, e));
      }
    } catch (e) {
      console.error(`[room:${id}] adapter start failed`, e);
    }
  }

  /* ---------------- 元信息 ---------------- */
  meta() {
    return {
      id: this.id,
      gameId: this.gameId,
      gameName: this.def.name,
      mode: this.def.mode || 'inprocess',
      phase: this.phase,
      maxPlayers: this.maxPlayers,
      minPlayers: this.def.minPlayers || 1,
      allowSpectators: this.def.allowSpectators !== false,
      seats: this.seats.map(c => (c ? { name: c.name, admin: !!c.admin, online: !!(c.ws && c.ws.open) } : null)),
      playerCount: this.seats.filter(Boolean).length,
      specCount: this.spectators.size,
      ready: this.ready,
      entry: this.adapter.entry ? this.adapter.entry() : null,
      createdAt: this.createdAt,
    };
  }

  seatList() {
    return this.seats.map((c, i) => (c
      ? { seat: i, id: c.id, name: c.name, admin: !!c.admin, online: !!(c.ws && c.ws.open) }
      : null));
  }

  spectatorList() {
    return Array.from(this.spectators).map(c => ({
      id: c.id, name: c.name, admin: !!c.admin, online: !!(c.ws && c.ws.open),
    }));
  }

  members() {
    const out = [];
    for (const c of this.seats) if (c) out.push(c);
    for (const c of this.spectators) out.push(c);
    return out;
  }

  isEmpty() {
    return this.seats.every(s => !s) && this.spectators.size === 0;
  }

  /* ---------------- 加入 / 离开 ---------------- */
  join(conn) {
    const seat = this.seats.indexOf(null);
    if (seat !== -1) {
      this.seats[seat] = conn;
      conn.room = this;
      conn.seat = seat;
      conn.isSpectator = false;
    } else {
      this.spectators.add(conn);
      conn.room = this;
      conn.seat = null;
      conn.isSpectator = true;
    }
    this.lobby.cancelDestroy(this);
    try { this.adapter.onJoin(this.playerView(conn)); }
    catch (e) { console.error(`[room:${this.id}] onJoin error`, e); }

    conn.send({
      t: 'entered',
      room: this.meta(),
      you: this.you(conn),
      entry: this.adapter.entry ? this.adapter.entry() : null,
      snapshot: this.adapter.snapshot ? this.adapter.snapshot() : null,
    });
    this.broadcastRoom();
  }

  you(conn) {
    return {
      seat: conn.seat,
      spectator: !!conn.isSpectator,
      name: conn.name,
      admin: !!conn.admin,
      roomId: this.id,
      gameId: this.gameId,
    };
  }

  leave(conn) {
    if (conn.seat !== null && conn.room === this && this.seats[conn.seat] === conn) {
      this.seats[conn.seat] = null;
    }
    this.spectators.delete(conn);
    conn.room = null;
    conn.seat = null;
    conn.isSpectator = false;

    try { this.adapter.onLeave(this.playerView(conn)); }
    catch (e) { console.error(`[room:${this.id}] onLeave error`, e); }

    this.broadcastRoom();
    if (this.isEmpty()) this.lobby.scheduleDestroy(this);
  }

  playerView(conn) {
    return {
      id: conn.id,
      name: conn.name,
      admin: !!conn.admin,
      seat: conn.seat,
      spectator: !!conn.isSpectator,
      online: !!(conn.ws && conn.ws.open),
    };
  }

  /* ---------------- 游戏消息(仅进程内游戏) ---------------- */
  onGameMessage(conn, msg) {
    try { this.adapter.onMessage(this.playerView(conn), msg); }
    catch (e) { console.error(`[room:${this.id}] onMessage error`, e); }
  }

  /* ---------------- 发送 ---------------- */
  setPhase(p) {
    if (this.phase !== p) this.phase = p;
  }

  broadcast(obj, except) {
    for (const c of this.members()) {
      if (c !== except) c.send(obj);
    }
  }

  // 游戏消息统一包一层 { t:'g', m:... },与大厅控制消息隔离
  sendGame(obj, except) {
    this.broadcast({ t: 'g', m: obj }, except);
  }
  sendGameToSeat(seat, obj) {
    const c = this.seats[seat];
    if (c) c.send({ t: 'g', m: obj });
  }
  sendGameToSpectators(obj) {
    for (const c of this.spectators) c.send({ t: 'g', m: obj });
  }
  sendGameToPlayer(player, obj) {
    const c = this._connOf(player);
    if (c) c.send({ t: 'g', m: obj });
  }

  _connOf(player) {
    if (!player) return null;
    if (player.seat !== null && player.seat !== undefined && this.seats[player.seat]) {
      return this.seats[player.seat];
    }
    for (const c of this.spectators) if (c.id === player.id) return c;
    return null;
  }

  broadcastRoom() {
    const meta = this.meta();
    this.broadcast({ t: 'room', room: meta });
    this.lobby.roomsChanged();
  }

  /* ---------------- 适配器回调 ---------------- */
  onAdapterReady() {
    this.ready = true;
    if (this.destroyed) return;
    this.broadcastRoom();
  }

  onAdapterExit() {
    if (this.destroyed) return;
    this.broadcast({ t: 'msg', text: '游戏进程已退出,房间即将关闭' });
    this.lobby.scheduleDestroy(this, 3000);
  }

  /* ---------------- 销毁 ---------------- */
  destroy(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.adapter.dispose(); } catch (e) { /* ignore */ }
    const msg = { t: 'left', reason: reason || '房间已关闭' };
    for (const c of this.members()) {
      c.room = null;
      c.seat = null;
      c.isSpectator = false;
      c.send(msg);
    }
    this.seats.fill(null);
    this.spectators.clear();
    this.lobby.remove(this.id);
  }
}

module.exports = Room;
