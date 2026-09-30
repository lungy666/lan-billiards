/*
 * hall/test/test-spider.js —— 蜘蛛纸牌:选难度开局 / 发牌 / 移动 / 撤销 / 观战只读
 *
 * 需要先启动大厅:node hall/index.js
 * 大厅端口通过环境变量 HALL_PORT 指定,默认 3999。
 */
const PORT = process.env.HALL_PORT || 3999;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, ws, msgs: [] };
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    c.msgs.push(m);
  });
  c.open = new Promise(res => ws.addEventListener('open', res));
  c.send = o => ws.send(JSON.stringify(o));
  c.mark = () => c.msgs.length;
  c.waitFrom = (start, pred, ms = 3000) => new Promise((resolve, reject) => {
    const check = () => {
      for (let i = start; i < c.msgs.length; i++) if (pred(c.msgs[i])) return c.msgs[i];
      return null;
    };
    const hit = check();
    if (hit) return resolve(hit);
    const timer = setInterval(() => {
      const r = check();
      if (r) { clearInterval(timer); clearTimeout(to); resolve(r); }
    }, 15);
    const to = setTimeout(() => { clearInterval(timer); reject(new Error(name + ' timeout waiting after ' + start)); }, ms);
  });
  c.close = () => ws.close();
  return c;
}

const isState = m => m.t === 'g' && m.m && m.m.a === 'state' && m.m.started;
const lastState = c => { for (let i = c.msgs.length - 1; i >= 0; i--) if (isState(c.msgs[i])) return c.msgs[i].m; return null; };

function findMove(st) {
  const cols = st.columns;
  for (let from = 0; from < cols.length; from++) {
    const src = cols[from];
    if (!src.length) continue;
    const top = src[src.length - 1];
    if (!top.u) continue;
    for (let to = 0; to < cols.length; to++) {
      if (to === from) continue;
      const dst = cols[to];
      if (!dst.length) return { from, index: src.length - 1, to };
      const dt = dst[dst.length - 1];
      if (dt.u && dt.r === top.r + 1) return { from, index: src.length - 1, to };
    }
  }
  return null;
}

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } }

(async () => {
  console.log('== 1) 登录 / 创建房间 ==');
  const A = client('Alice'), B = client('Bob');
  await A.open; await B.open;
  A.send({ t: 'hello', name: 'Alice' });
  B.send({ t: 'hello', name: 'Bob' });
  await A.waitFrom(0, m => m.t === 'welcome');
  await B.waitFrom(0, m => m.t === 'welcome');

  A.send({ t: 'create', gameId: 'spider' });
  const ea = await A.waitFrom(0, m => m.t === 'entered');
  const roomId = ea.room.id;
  ok(ea.you.seat === 0, 'A 坐 0 号位(单机)');
  ok(ea.room.maxPlayers === 1, '房间只有 1 个座位');
  ok(ea.entry && ea.entry.mode === 'inline', '内置游戏用 inline 模式');
  ok(ea.snapshot && ea.snapshot.started === false, '入座后等待选择难度(不自动开局)');

  console.log('== 2) 选择难度开局 ==');
  let mark = A.mark();
  A.send({ t: 'g', m: { a: 'new', suits: 1 } });
  await A.waitFrom(mark, m => isState(m) && m.m.suitCount === 1 && m.m.moves === 0);
  let st = lastState(A);
  ok(st.columns.length === 10, '发 10 列牌');
  ok(st.stock === 50 && st.dealsLeft === 5, '牌堆 50 张 / 可发 5 次');
  ok(st.columns[0][0].u === 0, '列底为暗牌(仅顶张亮)');
  ok(st.gameSeq === 1, '新局 gameSeq=1');

  console.log('== 3) 非法移动被拒绝 ==');
  A.send({ t: 'g', m: { a: 'move', from: 0, index: 0, to: 1 } });
  await sleep(150);
  ok(lastState(A).moves === 0, '暗牌 / 非法移动被拒绝');

  console.log('== 4) 发牌 ==');
  mark = A.mark();
  A.send({ t: 'g', m: { a: 'deal' } });
  await A.waitFrom(mark, m => isState(m) && m.m.moves === 1);
  st = lastState(A);
  ok(st.stock === 40 && st.dealsLeft === 4, '发牌后牌堆 40 张 / 可发 4 次');
  ok(st.columns.every(col => col[col.length - 1].u), '每列顶牌均为亮牌');
  ok(st.canUndo === true, '可撤销');

  console.log('== 5) 撤销 ==');
  mark = A.mark();
  A.send({ t: 'g', m: { a: 'undo' } });
  await A.waitFrom(mark, m => isState(m) && m.m.moves === 0);
  st = lastState(A);
  ok(st.stock === 50 && st.dealsLeft === 5, '撤销恢复牌堆到 50 张');
  ok(st.canUndo === false, '撤销到底后不可再撤销');

  console.log('== 6) 合法移动 ==');
  let found = findMove(st), baseMoves = st.moves, deals = 0;
  while (!found && st.dealsLeft > 0 && deals < 5) {
    mark = A.mark();
    A.send({ t: 'g', m: { a: 'deal' } });
    await A.waitFrom(mark, m => isState(m) && m.m.moves > baseMoves);
    st = lastState(A); baseMoves = st.moves; deals++;
    found = findMove(st);
  }
  ok(!!found, '找到一步合法移动');
  if (found) {
    const before = st.moves;
    mark = A.mark();
    A.send({ t: 'g', m: { a: 'move', from: found.from, index: found.index, to: found.to } });
    await A.waitFrom(mark, m => isState(m) && m.m.moves === before + 1);
    ok(true, '合法移动成功,步数 +1');
    mark = A.mark();
    A.send({ t: 'g', m: { a: 'undo' } });
    await A.waitFrom(mark, m => isState(m) && m.m.moves === before);
    ok(true, '移动后撤销成功');
  }

  console.log('== 7) 观战(只读)==');
  mark = B.mark();
  B.send({ t: 'enter', roomId });
  const eb = await B.waitFrom(mark, m => m.t === 'entered');
  ok(eb.you.seat === null && eb.you.spectator, 'B 进入观战');
  ok(eb.snapshot && eb.snapshot.started, '观战者收到牌局快照');

  const specBefore = lastState(A);
  B.send({ t: 'g', m: { a: 'deal' } });
  B.send({ t: 'g', m: { a: 'new', suits: 4 } });
  await sleep(200);
  const specAfter = lastState(A);
  ok(specAfter.moves === specBefore.moves && specAfter.suitCount === specBefore.suitCount,
    '观战者无法操作牌局');

  console.log('== 8) 三种难度 ==');
  for (const suits of [1, 2, 4]) {
    mark = A.mark();
    A.send({ t: 'g', m: { a: 'new', suits } });
    await A.waitFrom(mark, m => isState(m) && m.m.suitCount === suits && m.m.moves === 0);
    const s2 = lastState(A);
    ok(s2.suitCount === suits && s2.stock === 50 && s2.canUndo === false && s2.foundations.length === 0,
      `难度 ${suits} 花色可正常开局`);
  }
  ok(lastState(A).gameSeq !== st.gameSeq, '每次新局 gameSeq 递增(供前端播放发牌动画)');

  console.log('== 9) 离开 ==');
  mark = A.mark();
  A.send({ t: 'leave' });
  await A.waitFrom(mark, m => m.t === 'left');
  ok(true, '离开房间收到 left');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  A.close(); B.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
