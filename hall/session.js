/*
 * hall/session.js —— 一个客户端连接(会话)
 *
 * 负责:身份(hello)、大厅指令、房间进入/离开、游戏消息路由。
 * 客户端与大厅只维持一条 WebSocket。
 */
'use strict';

class Session {
  constructor(ws, lobby, config, id) {
    this.ws = ws;
    this.lobby = lobby;
    this.config = config;
    this.id = id;
    this.name = '';
    this.admin = false;
    this.helloed = false;
    this.room = null;          // 当前房间(Room 实例)
    this.seat = null;          // 座位号;null 表示观战或未进房
    this.isSpectator = false;

    ws.onmessage = raw => {
      ws.alive = true;
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m && typeof m === 'object') {
        try { this.handle(m); } catch (e) { console.error('[session] handle error', e); }
      }
    };
    ws.onclose = () => this.close();
  }

  send(obj) {
    if (this.ws && this.ws.open) this.ws.send(JSON.stringify(obj));
  }

  /* ---------------- 消息分发 ---------------- */
  handle(m) {
    if (!this.helloed) {
      if (m.t === 'hello') return this.hello(m);
      this.send({ t: 'err', text: '请先发送 hello' });
      return;
    }
    switch (m.t) {
      case 'list':   this.send({ t: 'rooms', rooms: this.lobby.listRooms() }); return;
      case 'games':  this.send({ t: 'games', games: this.lobby.gameList() }); return;
      case 'create': return this.create(m.gameId);
      case 'enter':  return this.enter(m.roomId);
      case 'leave':  return this.leave();
      case 'g':      return this.gameMsg(m.m);
      case 'chat':   return this.chat(m.text);
      case 'admin':  return this.adminCmd(m);
      default:       return;
    }
  }

  hello(m) {
    this.helloed = true;
    let name = String(m.name == null ? '' : m.name).trim().slice(0, 12) || '玩家';
    const pass = typeof m.adminPass === 'string' ? m.adminPass : '';
    const wantAdmin = pass.length > 0;
    this.admin = wantAdmin && pass === this.config.hall.adminPassword;
    if (wantAdmin && !this.admin) this.send({ t: 'msg', text: '管理员密码错误,已按普通玩家加入' });
    this.name = name;

    this.send({
      t: 'welcome',
      you: { id: this.id, name: this.name, admin: this.admin },
      games: this.lobby.gameList(),
      rooms: this.lobby.listRooms(),
    });
  }

  create(gameId) {
    const def = this.lobby.games.get(gameId);
    if (!def) { this.send({ t: 'err', text: '没有这个游戏' }); return; }
    if (!this.canEnter(def)) return;
    const room = this.lobby.createRoom(gameId);
    if (!room) { this.send({ t: 'err', text: '创建房间失败' }); return; }
    this.enterRoom(room);
  }

  enter(roomId) {
    const room = this.lobby.getRoom(roomId);
    if (!room || room.destroyed) { this.send({ t: 'err', text: '房间不存在或已关闭' }); return; }
    if (!this.canEnter(room.def)) return;
    this.enterRoom(room);
  }

  canEnter(def) {
    if (def.mode === 'external' && !def.command) {
      this.send({ t: 'err', text: '该游戏未配置启动命令' });
      return false;
    }
    return true;
  }

  enterRoom(room) {
    if (this.room === room) { this.send({ t: 'entered', room: room.meta(), you: room.you(this), entry: room.adapter.entry ? room.adapter.entry() : null, snapshot: room.adapter.snapshot ? room.adapter.snapshot() : null }); return; }
    this.leave(true);
    room.join(this);
  }

  leave(silent) {
    if (this.room) {
      const r = this.room;
      r.leave(this);
      if (!silent) this.send({ t: 'left' });
    } else if (!silent) {
      this.send({ t: 'left' });
    }
  }

  gameMsg(m) {
    if (this.room) this.room.onGameMessage(this, m);
  }

  chat(text) {
    const msg = String(text == null ? '' : text).slice(0, 200);
    if (!msg) return;
    const payload = { t: 'chat', from: this.name, text: msg };
    if (this.room) this.room.broadcast(payload);
    else this.lobby.broadcastLobby(payload, this);
  }

  adminCmd(m) {
    if (!this.admin) { this.send({ t: 'err', text: '需要管理员权限' }); return; }
    if (m.cmd === 'closeRoom') {
      const room = this.room || this.lobby.getRoom(m.roomId);
      if (!room) { this.send({ t: 'err', text: '房间不存在' }); return; }
      room.destroy('管理员关闭了房间');
    } else if (m.cmd === 'closeAll') {
      for (const room of Array.from(this.lobby.rooms.values())) room.destroy('管理员关闭了房间');
    }
  }

  close() {
    if (this.room) {
      this.room.leave(this);
    }
    this.lobby.removeSession(this);
  }
}

module.exports = Session;
