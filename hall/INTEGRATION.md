# 游戏大厅 · 接入指南(INTEGRATION)

本大厅负责**房间管理、玩家会话、连接路由与状态同步**,不关心具体游戏规则。
一款游戏有两种接入方式,可选择最省事的那种:

| | 方式 A:外部进程 | 方式 B:进程内模块 |
|---|---|---|
| 适用 | 已有独立网页游戏、非 JS / 其它语言 | 新写的 JS 小游戏 |
| 改动量 | **零改动**(改配置即可) | 实现一组接口 |
| 隔离性 | 每房间一个进程,崩溃互不影响 | 同进程,轻量高效 |
| 前端 | 自带页面,被大厅以 iframe 嵌入 | 提供 JS 模块,共用大厅连接 |
| 例子 | 现有台球 `server.js` | 五子棋 `hall/games/gomoku/` |

两种方式可以混用。下面分别说明。

---

## 一、总体结构

```
hall/
├── index.js            入口:HTTP 静态 + WS + 房间路由
├── games.config.js     游戏注册表(接入点)
├── lobby.js            房间注册表 / 列表
├── room.js             房间:座位 / 观战 / 生命周期
├── session.js          一个客户端会话
├── adapters/
│   ├── inprocess.js    方式 B:进程内游戏适配器
│   └── external.js     方式 A:外部进程适配器
├── games/<id>/         进程内游戏(服务端 + 前端)
│   ├── server.js       GameModule 实现
│   └── public/client.js 前端模块
└── public/             大厅自身 UI
```

**核心思想**:`Room` 只面对统一的 *适配器接口*;游戏实现通过适配器挂进来,
所以新增游戏不需要改大厅核心代码。

---

## 二、方式 B:进程内游戏(GameModule 接口)

### 1. 目录约定

```
hall/games/<游戏id>/
├── server.js          # 服务端:实现 GameModule,入口必须是这个相对路径(可在 config 改)
└── public/
    └── client.js      # 前端:向 window.HallGames[<游戏id>] 注册
```
前端静态资源通过 `/games/<游戏id>/<文件名>` 访问,例如 `client.js` 对应
`/games/<游戏id>/client.js`。

### 2. 注册(必须)

在 `hall/games.config.js` 的 `games` 里加一条:

```js
{
  id: 'gomoku',                 // 唯一 id,同时是前端注册名
  name: '五子棋',
  desc: '一句话描述',
  mode: 'inprocess',
  entry: 'gomoku/server.js',    // 相对 hall/games/
  minPlayers: 2,
  maxPlayers: 2,
  allowSpectators: true,
}
```

### 3. 服务端:GameModule

`server.js` 导出一个对象,所有字段可选,按需实现:

```js
module.exports = {
  id: 'gomoku',            // 建议与 config 一致
  name: '五子棋',
  minPlayers: 2,
  maxPlayers: 2,
  allowSpectators: true,
  tickHz: 0,               // >0 时大厅每秒调用 tick 该次数(实时游戏用,如台球 60)

  // 房间创建时调用一次:初始化游戏状态,建议挂在 ctx.state 上
  createState(ctx) {},

  // 玩家入座 / 观战者进入时调用(player.seat 为 null 表示观战)
  onJoin(ctx, player) {},

  // 玩家 / 观战者离开时调用
  onLeave(ctx, player) {},

  // 收到本游戏的客户端消息(消息体已由大厅剥出,见下)
  onMessage(ctx, player, msg) {},

  // tickHz>0 时按固定步长调用
  tick(ctx, dt) {},

  // 返回给"中途进入者"的初始快照(可含隐藏信息裁减)
  snapshot(ctx) {},

  // 房间销毁时清理定时器 / 资源
  dispose(ctx) {},
};
```

`player` 对象(只读):

```js
{
  id,          // 会话 id
  name,        // 昵称
  admin,       // 是否大厅管理员
  seat,        // 座位号;观战为 null
  spectator,   // 是否观战
  online,      // 是否在线
}
```

### 4. 上下文 ctx(游戏操作房间的唯一入口)

```js
ctx = {
  id,              // 房间号
  gameId,          // 游戏 id
  phase,           // 'waiting' | 'playing' | 'finished'
  state,           // 游戏私有状态(随房间存活,可自由赋值)

  seats,           // [{seat,id,name,admin,online} | null, ...]
  spectators,      // [{id,name,admin,online}, ...]

  setPhase(p),              // 切换房间阶段
  broadcast(obj),           // 房间内所有人
  toSeat(seat, obj),        // 指定座位
  toSpectators(obj),        // 所有观战者
  send(player, obj),        // 指定玩家 / 观战者
  log(text),                // 房间内弹一条提示

  now(),                    // 当前时间戳
}
```

> **状态变更后务必主动推送**。进程内游戏由你决定何时广播 `ctx.broadcast(...)`。
> 建议每次状态变化后广播一份完整状态(五子棋即如此),简单且不易错。
> 实时游戏可在 `tick` 里按帧广播。

### 5. 客户端:HallGames 模块

`client.js` 里注册:

```js
window.HallGames = window.HallGames || {};
window.HallGames['<游戏id>'] = {
  // 进入房间时调用:container 是挂载容器,api 见下
  mount(container, api) {},

  // 离开房间时调用:清理事件监听 / RAF
  unmount() {},

  // 收到服务端 ctx.broadcast / toSeat / send 发出的游戏消息
  onMessage(m) {},

  // 收到 snapshot() 的快照
  onSnapshot(state) {},

  // 房间元信息变化(座位、阶段等)
  onRoom(room, me) {},
};
```

`api`(大厅提供给前端):

```js
api = {
  me,         // { seat, spectator, name, admin, roomId, gameId }
  room,       // 房间元信息
  snapshot,   // snapshot() 的返回值
  send(m),    // 发送一条游戏消息 -> 服务端 onMessage(ctx, player, m)
  toast(text) // 顶部提示
}
```

### 6. 消息流

```
浏览器                     大厅(Session/Room)              游戏模块
  │  {t:'g', m:{...}}  ──►  Room.onGameMessage  ──►  onMessage(ctx, player, m)
  │                                                      │
  │  ◄── {t:'g', m:{...}}  ◄── ctx.broadcast(obj) ◄──────┘
```

- 大厅控制消息(`hello/create/enter/leave/list/chat/admin`)与游戏消息完全隔离;
- 游戏消息体(`m`)结构完全由游戏自定义,大厅不解析。

### 7. 最小骨架

服务端:

```js
module.exports = {
  id: 'demo', tickHz: 0,
  createState(ctx) { ctx.state = { n: 0 }; },
  onMessage(ctx, player, m) {
    if (m.a === 'inc') { ctx.state.n++; ctx.broadcast({ a: 'n', n: ctx.state.n }); }
  },
  snapshot(ctx) { return { a: 'n', n: ctx.state.n }; },
};
```

前端:

```js
window.HallGames = window.HallGames || {};
window.HallGames.demo = {
  mount(el, api) {
    el.innerHTML = '';
    const b = document.createElement('button');
    b.textContent = '点我 +1';
    b.onclick = () => api.send({ a: 'inc' });
    el.appendChild(b);
    this.n = (api.snapshot && api.snapshot.n) || 0;
  },
  onMessage(m) { if (m.a === 'n') console.log('n =', m.n); },
};
```

用例:五子棋 `hall/games/gomoku/{server.js, public/client.js}`。

---

## 三、方式 A:外部游戏(独立进程,零改动)

只要你的游戏是"一个自带 HTML 页面 + WebSocket 的 HTTP 服务"即可接入。

### 1. 注册

```js
{
  id: 'billiards',
  name: '台球 · 黑八',
  mode: 'external',
  command: 'server.js',      // 相对项目根目录,由 node 启动
  args: [],                  // 可选启动参数
  minPlayers: 2, maxPlayers: 2,
  allowSpectators: true,
}
```

### 2. 约定

- 大厅为每个房间分配一个空闲端口(`hall.external.portStart` 起),并以
  环境变量 `PORT` 启动你的进程;同时传入 `HALL_ROOM` / `HALL_GAME` 供参考。
- 进程需监听 `0.0.0.0:PORT`,根路径 `/` 返回游戏页面。
- 大厅检测到 `/` 可访问后,把页面以 **iframe** 嵌入房间,座位由大厅按加入顺序分配。
- 房间空置后,大厅会结束该进程。

### 3. 说明

- 游戏与浏览器直接通信,大厅不转发其 WebSocket 消息,因此**游戏代码完全不用改**;
- 代价:大厅只知道房间里有几个人、什么阶段是它自己维护的,不感知游戏内部状态;
- 若希望大厅显示更精确的状态,可选:游戏向大厅回报(当前版本未强制,后续可扩展)。

现有台球 `server.js` 即以此方式接入,未做任何修改。

---

## 四、大厅通用协议(客户端 ↔ 大厅)

| 方向 | 消息 | 说明 |
|---|---|---|
| C→S | `{t:'hello', name, adminPass?}` | 登录(必须先发) |
| C→S | `{t:'list'}` | 请求房间列表 |
| C→S | `{t:'games'}` | 请求游戏列表 |
| C→S | `{t:'create', gameId}` | 创建房间并进入 |
| C→S | `{t:'enter', roomId}` | 加入房间(座位满则观战) |
| C→S | `{t:'leave'}` | 离开房间 |
| C→S | `{t:'g', m}` | 游戏消息(进程内游戏) |
| C→S | `{t:'chat', text}` | 聊天 |
| C→S | `{t:'admin', cmd}` | 管理员:`closeRoom` / `closeAll` |
| S→C | `{t:'welcome', you, games, rooms}` | 登录成功 |
| S→C | `{t:'rooms', rooms}` | 房间列表 |
| S→C | `{t:'entered', room, you, entry, snapshot}` | 成功进入房间 |
| S→C | `{t:'room', room}` | 房间元信息更新 |
| S→C | `{t:'g', m}` | 游戏消息 |
| S→C | `{t:'left', reason?}` | 已离开房间 |
| S→C | `{t:'msg', text}` / `{t:'err', text}` | 提示 / 错误 |

房间元信息 `room`:

```js
{
  id, gameId, gameName, mode, phase, maxPlayers, minPlayers,
  seats: [{name, admin, online} | null, ...],
  playerCount, specCount, ready,
  entry: { mode:'inline'|'iframe', script?/port?, ready },
  createdAt,
}
```

---

## 五、配置项(hall/games.config.js)

| 键 | 说明 |
|---|---|
| `games[]` | 游戏注册表(见上) |
| `external.portStart` / `portRange` | 外部游戏端口范围 |
| `external.readyTimeout` | 等待外部进程就绪超时(ms) |
| `hall.title` | 大厅标题 |
| `hall.adminPassword` | 大厅管理员密码(可用环境变量 `ADMIN_PASSWORD`) |
| `hall.maxSessions` | 最大同时连接数 |
| `roomEmptyGraceMs` | 房间空置自动销毁的宽限时间 |

---

## 六、运行与自测

```bash
# 启动大厅(主入口,默认 3000)
node hall/index.js
# 换端口
HALL_PORT=8080 node hall/index.js

# 自测
node hall/test/test-gomoku.js     # 进程内:五子棋对局/观战/再来一局
node hall/test/test-external.js   # 外部进程:台球房间启动与页面可达
```

浏览器打开 `http://<局域网IP>:3000` 即可。

---

## 七、约定与注意事项

1. **进程内游戏的状态必须放 `ctx.state`**(不要用模块级变量),因为同一模块会有多个房间实例。
2. 房间内所有广播请走 `ctx`,不要自行持有连接对象。
3. 前端在 `unmount` 时务必移除 `window` 事件监听与动画循环,避免切换房间后残留。
4. 观战者同样会收到 `ctx.broadcast`;若信息需要保密(如牌类游戏的手牌),
   请改用 `ctx.toSeat(seat, obj)` 定向发送,并在 `snapshot` 中按人裁剪。
5. `maxPlayers` 决定座位数;多出的进入者自动成为观战者(`allowSpectators:false` 时后续被拒绝——此为预留开关,当前版本仍按观战处理)。
6. 外部游戏请自行处理玩家断线、重连与规则;大厅只负责进程与 iframe 生命周期。
