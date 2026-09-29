/*
 * wslib.js —— 零依赖 WebSocket 服务端实现(RFC 6455 精简版)
 * 仅需文本帧收发、ping/pong、关闭,足够局域网页游使用
 */
'use strict';
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.alive = true;
    this.fragBuf = null;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', d => this._onData(d));
    const gone = () => this._closed();
    socket.on('close', gone);
    socket.on('end', gone);
    socket.on('error', gone);
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    if (this.onclose) this.onclose();
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.open) {
      const f = this._parse();
      if (!f) break;
      if (f.opcode === 0x8) {           // close
        try { this._sendFrame(0x8, f.payload); } catch (e) {}
        try { this.socket.destroy(); } catch (e) {}
        this._closed();
      } else if (f.opcode === 0x9) {    // ping → pong
        try { this._sendFrame(0xA, f.payload); } catch (e) {}
        this.alive = true;
      } else if (f.opcode === 0xA) {    // pong
        this.alive = true;
      } else if (f.opcode === 0x1 || f.opcode === 0x2) {
        if (!f.fin) { this.fragBuf = Buffer.from(f.payload); }
        else if (this.onmessage) this.onmessage(f.payload.toString('utf8'));
      } else if (f.opcode === 0x0) {    // continuation
        if (this.fragBuf) {
          this.fragBuf = Buffer.concat([this.fragBuf, f.payload]);
          if (f.fin) {
            const p = this.fragBuf; this.fragBuf = null;
            if (this.onmessage) this.onmessage(p.toString('utf8'));
          }
        }
      }
    }
  }

  _parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      if (b.readUInt32BE(2) !== 0) return null;
      len = b.readUInt32BE(6); off = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (masked && len > 0) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  send(str) {
    if (this.open) {
      try { this._sendFrame(0x1, Buffer.from(str, 'utf8')); } catch (e) { this._closed(); }
    }
  }

  ping() {
    if (this.open) {
      try { this._sendFrame(0x9, Buffer.alloc(0)); } catch (e) {}
    }
  }

  close() {
    if (!this.open) return;
    try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (e) {}
    const s = this.socket;
    setTimeout(() => { try { s.destroy(); } catch (e) {} }, 80);
    this._closed();
  }

  _sendFrame(op, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op; header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }
}

// 挂到 http server 上:握手后通过 onConnection(conn, req) 交出连接
function attach(server, onConnection) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade.indexOf('websocket') === -1) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
    onConnection(new WSConn(socket), req);
  });
}

module.exports = { attach };
