/*
 * hall/games.config.js —— 游戏注册表
 *
 * 大厅据此展示游戏列表并创建房间。接入一款新游戏,通常只需在这里加一条记录:
 *
 *  mode: 'inprocess' —— 进程内游戏:实现 GameModule 接口的 JS 模块,
 *                      由大厅直接加载,可自定义前端,共用大厅 WebSocket。
 *                      见 hall/games/gomoku/ 与 hall/INTEGRATION.md。
 *
 *  mode: 'external'  —— 外部游戏:一个独立进程(自带 HTTP + WebSocket 服务),
 *                      大厅为其分配端口并嵌入 iframe,游戏无需改一行代码。
 *                      见现有台球 server.js。
 */
'use strict';

module.exports = {
  games: [
    {
      id: 'gomoku',
      name: '五子棋',
      desc: '15×15 棋盘,先连成五子者获胜',
      mode: 'inprocess',
      entry: 'gomoku/server.js',        // 相对 hall/games/
      minPlayers: 2,
      maxPlayers: 2,
      allowSpectators: true,
    },
    {
      id: 'billiards',
      name: '台球 · 黑八',
      desc: '局域网双人黑八(独立进程接入,现有代码零改动)',
      mode: 'external',
      command: 'server.js',             // 相对项目根目录
      args: [],
      minPlayers: 2,
      maxPlayers: 2,
      allowSpectators: true,
    },
  ],

  // 外部游戏进程配置
  external: {
    portStart: 3100,
    portRange: 200,
    readyTimeout: 8000,   // 等待子进程可访问的最长时间(ms)
  },

  // 大厅自身配置
  hall: {
    title: '局域网游戏大厅',
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
    maxSessions: 64,
  },

  // 房间空置多久后自动销毁(给断线重连留出时间)
  roomEmptyGraceMs: 15000,
};
