/*
 * hall/index.js —— 游戏大厅入口
 *
 * 职责:
 *   - 静态托管大厅 UI 与"进程内游戏"的前端资源
 *   - 单一 WebSocket 入口,按会话路由到对应房间
 *   - 房间/游戏注册与生命周期管理
 *
 * 运行:node hall/index.js      (端口 HALL_PORT / PORT,默认 3000)
 */
'use strict';
const http = require('http');
const path = require('path');
const os = require('os');
const wslib = require('../wslib');
const Lobby = require('./lobby');
const Session = require('./session');
const config = require('./games.config');
const { sendJson, serveFile } = require('./util');

const PORT = parseInt(process.env.HALL_PORT || process.env.PORT, 10) || 3000;
const HALL_PUBLIC = path.join(__dirname, 'public');
const GAMES_DIR = path.join(__dirname, 'games');

const lobby = new Lobby(config);
let nextSessionId = 1;

/* ---------------- HTTP:静态资源与 API ---------------- */
function handleHttp(req, res) {
  let pathname;
  try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { pathname = '/'; }

  if (pathname === '/api/games') return sendJson(res, { games: lobby.gameList() });
  if (pathname === '/api/rooms') return sendJson(res, { rooms: lobby.listRooms() });
  if (pathname === '/api/info') {
    return sendJson(res, { port: PORT, ips: lanIPs(), title: config.hall.title });
  }

  if (pathname === '/') return serveFile(res, path.join(HALL_PUBLIC, 'index.html'), HALL_PUBLIC);

  // 进程内游戏的前端资源:/games/<id>/<file> -> hall/games/<id>/public/<file>
  const gm = pathname.match(/^\/games\/([A-Za-z0-9_-]+)\/(.+)$/);
  if (gm) {
    const def = lobby.games.get(gm[1]);
    if (!def || def.mode === 'external') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const base = path.join(GAMES_DIR, def.id, 'public');
    return serveFile(res, path.join(base, gm[2]), base);
  }

  // 大厅自身静态资源
  serveFile(res, path.join(HALL_PUBLIC, pathname), HALL_PUBLIC);
}

/* ---------------- WebSocket ---------------- */
function onConnection(ws, req) {
  if (lobby.sessions.size >= (config.hall.maxSessions || 64)) {
    try { ws.close(); } catch (e) {}
    return;
  }
  const session = new Session(ws, lobby, config, nextSessionId++);
  lobby.addSession(session);
}

/* 心跳:清理死连接 */
setInterval(() => {
  for (const s of lobby.sessions) {
    const ws = s.ws;
    if (!ws || !ws.open) { lobby.removeSession(s); continue; }
    if (!ws.alive) { try { ws.close(); } catch (e) {} continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

/* ---------------- LAN 信息 ---------------- */
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const it of ifs[k] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

/* ---------------- 启动 ---------------- */
const server = http.createServer(handleHttp);
wslib.attach(server, onConnection);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`  🎮  ${config.hall.title}已启动`);
  console.log('  ────────────────────────────────');
  console.log(`  本机:    http://127.0.0.1:${PORT}`);
  for (const ip of lanIPs()) console.log(`  局域网:  http://${ip}:${PORT}`);
  console.log('');
  console.log('  已注册游戏:');
  for (const g of lobby.gameList()) {
    const tag = g.mode === 'external' ? '外部进程' : '内置';
    console.log(`    - ${g.name} [${g.id}] · ${tag} · ${g.minPlayers}-${g.maxPlayers} 人`);
  }
  console.log('');
  console.log(`  👑 大厅管理员密码: ${config.hall.adminPassword}   (可用环境变量 ADMIN_PASSWORD 修改)`);
  console.log('');
});
