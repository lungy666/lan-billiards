/*
 * hall/util.js —— 大厅通用小工具:HTTP JSON、静态文件、空闲端口分配、短 ID
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJson(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// 安全地把 file 当作 baseDir 下的静态文件返回(禁止越界)
function serveFile(res, file, baseDir, onNotFound) {
  const norm = path.normalize(file);
  if (baseDir && !norm.startsWith(path.normalize(baseDir))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(norm, (err, data) => {
    if (err) {
      if (onNotFound) onNotFound();
      else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(norm).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// 从 start 起找一个空闲端口(用于外部游戏进程)
function getFreePort(start, end) {
  return new Promise((resolve, reject) => {
    let port = start;
    const last = end || start + 200;
    const tryPort = () => {
      if (port > last) return reject(new Error(`no free port in [${start}, ${last}]`));
      const srv = net.createServer();
      let done = false;
      srv.once('error', () => { if (!done) { done = true; port++; tryPort(); } });
      srv.once('listening', () => {
        if (done) return;
        done = true;
        srv.close(() => resolve(port));
      });
      srv.listen(port, '0.0.0.0');
    };
    tryPort();
  });
}

function shortId(n) {
  let s = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < (n || 5); i++) s += chars[(Math.random() * chars.length) | 0];
  return s;
}

module.exports = { MIME, sendJson, serveFile, getFreePort, shortId };
