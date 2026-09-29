/*
 * hall/adapters/external.js —— 外部游戏适配器(方案 A)
 *
 * 为一个房间 fork 一个独立游戏进程(自带 HTTP + WebSocket),
 * 大厅分配端口并把它的页面通过 iframe 嵌入。
 * 游戏端无需任何改动 —— 现有台球 server.js 即以此方式接入。
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const cfg = require('../games.config');
const { getFreePort } = require('../util');

const ROOT = path.join(__dirname, '..', '..');

class ExternalAdapter {
  constructor(room, def) {
    this.room = room;
    this.def = def;
    this.port = null;
    this.child = null;
    this.ready = false;
    this.starting = false;
    this.exited = false;
  }

  async start() {
    if (this.starting) return;
    this.starting = true;
    const ext = cfg.external || {};
    try {
      this.port = await getFreePort(ext.portStart || 3100, (ext.portStart || 3100) + (ext.portRange || 200));
    } catch (e) {
      this.room.log(`游戏进程端口分配失败:${e.message}`);
      return;
    }
    if (this.room.destroyed) return;

    const cmd = path.join(ROOT, this.def.command);
    this.child = spawn(process.execPath, [cmd].concat(this.def.args || []), {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(this.port),
        HALL_ROOM: this.room.id,
        HALL_GAME: this.def.id,
      }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    this.child.on('exit', (code, signal) => this._onExit(code, signal));
    this.child.on('error', err => this.room.log(`游戏进程启动失败:${err.message}`));

    this._pollReady(ext.readyTimeout || 8000);
  }

  _pollReady(timeout) {
    const deadline = Date.now() + timeout;
    const tick = () => {
      if (this.ready || this.room.destroyed || this.exited) return;
      if (Date.now() > deadline) {
        this.room.log('游戏进程启动超时');
        return;
      }
      const req = http.get(
        { host: '127.0.0.1', port: this.port, path: '/', timeout: 1000 },
        res => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) this._setReady();
          else setTimeout(tick, 250);
        }
      );
      req.on('error', () => setTimeout(tick, 250));
      req.on('timeout', () => { req.destroy(); setTimeout(tick, 250); });
    };
    tick();
  }

  _setReady() {
    if (this.ready) return;
    this.ready = true;
    this.room.onAdapterReady();
  }

  _onExit(code, signal) {
    this.exited = true;
    if (this.room.destroyed) return;
    this.room.log(`游戏进程已退出(${signal || code})`);
    this.room.onAdapterExit();
  }

  onJoin() { /* 外部游戏自行处理玩家连接 */ }
  onLeave() { /* 外部游戏自行处理玩家离开 */ }
  onMessage() { /* 不转发消息:外部游戏直接与浏览器通信 */ }
  snapshot() { return null; }

  entry() {
    return {
      mode: 'iframe',
      port: this.port,
      path: '/',
      ready: this.ready,
    };
  }

  dispose() {
    if (this.child && !this.exited) {
      try { this.child.kill(); } catch (e) { /* ignore */ }
    }
    this.child = null;
  }
}

module.exports = ExternalAdapter;
