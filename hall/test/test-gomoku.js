/* 大厅集成测试:五子棋对局 + 观战 + 再来一局 */
const URL = 'ws://127.0.0.1:3999/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, ws, msgs: [], waiters: [] };
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    c.msgs.push(m);
    for (const w of c.waiters.slice()) if (w.pred(m)) { w.resolve(m); c.waiters.splice(c.waiters.indexOf(w), 1); }
  });
  c.open = new Promise(res => ws.addEventListener('open', res));
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const hit = c.msgs.find(pred);
    if (hit) return resolve(hit);
    const w = { pred, resolve };
    c.waiters.push(w);
    setTimeout(() => { const i = c.waiters.indexOf(w); if (i >= 0) c.waiters.splice(i, 1); reject(new Error(name + ' timeout waiting')); }, ms);
  });
  c.close = () => ws.close();
  return c;
}

const state = m => m.t === 'g' && m.m && m.m.a === 'state';
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } }

(async () => {
  console.log('== 1) 登录 ==');
  const A = client('Alice'), C = client('Carol');
  await A.open; await C.open;
  A.send({ t: 'hello', name: 'Alice' }); C.send({ t: 'hello', name: 'Carol' });
  const wa = await A.wait(m => m.t === 'welcome');
  ok(wa.you.name === 'Alice', 'A 收到 welcome');
  ok(wa.games.some(g => g.id === 'gomoku'), '游戏列表含五子棋');

  console.log('== 2) 创建房间并加入 ==');
  A.send({ t: 'create', gameId: 'gomoku' });
  const ea = await A.wait(m => m.t === 'entered');
  const roomId = ea.room.id;
  ok(ea.you.seat === 0, 'A 坐 0 号位');
  ok(ea.entry && ea.entry.mode === 'inline', '内置游戏用 inline 模式');

  const B = client('Bob'); await B.open;
  B.send({ t: 'hello', name: 'Bob' });
  await B.wait(m => m.t === 'welcome');
  B.send({ t: 'enter', roomId });
  const eb = await B.wait(m => m.t === 'entered');
  ok(eb.you.seat === 1, 'B 坐 1 号位');

  // 开局状态
  const s0 = await A.wait(m => state(m) && m.m.started);
  ok(s0.m.started && s0.m.turn === 1, '两人就座后自动开局,轮到 1 号');

  console.log('== 3) 落子 / 非法落子 ==');
  B.send({ t: 'g', m: { a: 'place', x: 0, y: 0 } });  // 不是 B 的回合
  await sleep(100);
  let last = A.msgs.filter(state).pop();
  ok(last.m.moveCount === 0, '非本方回合落子被拒绝');

  A.send({ t: 'g', m: { a: 'place', x: 7, y: 7 } });
  await A.wait(m => state(m) && m.m.moveCount === 1);
  ok(true, 'A 落子成功');

  console.log('== 4) 观战 ==');
  C.send({ t: 'enter', roomId });
  const ec = await C.wait(m => m.t === 'entered');
  ok(ec.you.seat === null && ec.you.spectator, 'C 进入观战');
  ok(ec.snapshot && ec.snapshot.moveCount === 1, '观战者收到快照');

  console.log('== 5) 五连胜 ==');
  const seq = [[7, 6, true], [8, 5, false], [8, 7, true], [8, 6, false], [9, 7, true], [9, 6, false], [10, 7, true], [10, 6, false], [11, 7, true]];
  for (const [x, y, isA] of seq) {
    (isA ? A : B).send({ t: 'g', m: { a: 'place', x, y } });
    await A.wait(m => state(m) && m.m.moveCount >= A.msgs.filter(state).pop().m.moveCount);
    await sleep(30);
  }
  const win = await A.wait(m => state(m) && m.m.winner);
  ok(win.m.winner === 1, 'A(黑)五连获胜');

  console.log('== 6) 再来一局 ==');
  A.send({ t: 'g', m: { a: 'rematch' } });
  B.send({ t: 'g', m: { a: 'rematch' } });
  const re = await A.wait(m => state(m) && m.m.started && m.m.moveCount === 0 && !m.m.winner);
  ok(!!re, '双方同意后重开');

  console.log('== 7) 房主关闭 / 离开 ==');
  A.send({ t: 'leave' });
  const lf = await A.wait(m => m.t === 'left');
  ok(!!lf, '离开房间收到 left');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  A.close(); B.close(); C.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
