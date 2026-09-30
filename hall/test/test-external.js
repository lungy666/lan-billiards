/* 外部游戏(台球)适配测试:创建房间 -> 等待进程就绪 -> 访问子进程页面 */
const URL = 'ws://127.0.0.1:3999/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, msgs: [], waiters: [] };
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data); c.msgs.push(m);
    for (const w of c.waiters.slice()) if (w.pred(m)) { w.resolve(m); c.waiters.splice(c.waiters.indexOf(w), 1); }
  });
  c.open = new Promise(res => ws.addEventListener('open', res));
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 12000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find(pred); if (hit) return resolve(hit);
    const w = { pred, resolve }; c.waiters.push(w);
    setTimeout(() => { const i = c.waiters.indexOf(w); if (i >= 0) c.waiters.splice(i, 1); reject(new Error('timeout')); }, ms);
  });
  return c;
}

(async () => {
  const A = client('A'); await A.open;
  A.send({ t: 'hello', name: 'A', adminPass: 'admin123' });
  await A.wait(m => m.t === 'welcome');

  A.send({ t: 'create', gameId: 'billiards' });
  const ent = await A.wait(m => m.t === 'entered');
  console.log('房间:', ent.room.id, '模式:', ent.entry && ent.entry.mode, '初始就绪:', ent.entry && ent.entry.ready);

  // 等待子进程就绪(room 更新 ready=true),从 room.entry 取端口
  const ready = await A.wait(m => m.t === 'room' && m.room.ready, 12000);
  const port = ready.room.entry && ready.room.entry.port;
  console.log('进程就绪,端口:', port);

  const html = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
  const hasTitle = /局域网台球|黑八/.test(html);
  console.log('子进程页面可访问:', hasTitle ? '✓ 是' : '✗ 否');

  const phys = await fetch(`http://127.0.0.1:${port}/physics.js`);
  console.log('子进程 /physics.js:', phys.status);

  // 清理:关闭房间
  A.send({ t: 'admin', cmd: 'closeRoom', roomId: ent.room.id });
  await sleep(200);
  console.log('已请求关闭房间');
  process.exit(hasTitle && phys.status === 200 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
