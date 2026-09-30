/*
 * hall/lobby.js —— 大厅:游戏注册表 + 房间注册表 + 会话集合
 */
'use strict';
const Room = require('./room');

class Lobby {
  constructor(config) {
    this.config = config;
    this.games = new Map((config.games || []).map(g => [g.id, g]));
    this.rooms = new Map();
    this.sessions = new Set();
    this.destroyTimers = new Map();
    this.nextRoomSeq = 1;
  }

  gameList() {
    return Array.from(this.games.values()).map(g => ({
      id: g.id,
      name: g.name,
      desc: g.desc || '',
      mode: g.mode || 'inprocess',
      minPlayers: g.minPlayers || 1,
      maxPlayers: g.maxPlayers || 2,
      allowSpectators: g.allowSpectators !== false,
      theme: g.theme || null,
    }));
  }

  listRooms() {
    return Array.from(this.rooms.values())
      .filter(r => !r.destroyed)
      .map(r => r.meta());
  }

  createRoom(gameId) {
    const def = this.games.get(gameId);
    if (!def) return null;
    const id = 'r' + (this.nextRoomSeq++);
    const room = new Room(this, id, def);
    this.rooms.set(id, room);
    this.roomsChanged();
    return room;
  }

  getRoom(id) { return this.rooms.get(id); }

  remove(id) {
    this.rooms.delete(id);
    const t = this.destroyTimers.get(id);
    if (t) { clearTimeout(t); this.destroyTimers.delete(id); }
    this.roomsChanged();
  }

  scheduleDestroy(room, delayMs) {
    if (room.destroyed || this.destroyTimers.has(room.id)) return;
    const grace = delayMs != null ? delayMs : (this.config.roomEmptyGraceMs || 15000);
    const timer = setTimeout(() => {
      this.destroyTimers.delete(room.id);
      if (room.destroyed) return;
      if (!room.isEmpty()) return;
      room.destroy('房间已空置,自动关闭');
    }, grace);
    if (timer.unref) timer.unref();
    this.destroyTimers.set(room.id, timer);
  }

  cancelDestroy(room) {
    const t = this.destroyTimers.get(room.id);
    if (t) { clearTimeout(t); this.destroyTimers.delete(room.id); }
  }

  addSession(s) { this.sessions.add(s); }
  removeSession(s) { this.sessions.delete(s); }

  // 通知所有"还未进入房间"的会话:房间列表变化了
  roomsChanged() {
    const msg = { t: 'rooms', rooms: this.listRooms() };
    for (const s of this.sessions) {
      if (s.helloed && !s.room) s.send(msg);
    }
  }

  broadcastLobby(obj, except) {
    for (const s of this.sessions) {
      if (s !== except && s.helloed && !s.room) s.send(obj);
    }
  }
}

module.exports = Lobby;
