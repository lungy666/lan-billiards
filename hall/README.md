# 🎮 局域网游戏大厅

在现有"局域网台球"基础上新增的**多房间、多游戏**大厅。台球本身**零改动**,
以"外部进程"方式接入;新游戏以"进程内模块"方式接入。

## 快速开始

```bash
node hall/index.js          # 默认 http://0.0.0.0:3000
# 或换端口
HALL_PORT=8080 node hall/index.js
```

浏览器打开控制台打印的局域网地址即可。进入大厅后:

- **选择游戏** → 创建房间;
- **房间列表** → 加入别人的房间(座位满则自动观战)。

## 当前已接入

| 游戏 | 接入方式 | 说明 |
|---|---|---|
| 五子棋 | 进程内模块 | `hall/games/gomoku/`,接口参考实现 |
| 台球 · 黑八 | 外部进程 | 复用根目录 `server.js`,未改一行 |

## 目录

```
hall/
├── index.js          入口
├── games.config.js   游戏注册表(接入点)
├── lobby.js / room.js / session.js
├── adapters/         inprocess.js(方式B)/ external.js(方式A)
├── games/            进程内游戏
├── public/           大厅 UI
├── test/             自测脚本
└── INTEGRATION.md    ★ 新游戏接入指南
```

## 自测

```bash
node hall/test/test-gomoku.js     # 五子棋:对局 / 观战 / 再来一局
node hall/test/test-external.js   # 台球:外部进程启动与页面可达
```

## 接入新游戏

见 **[INTEGRATION.md](./INTEGRATION.md)**。核心要点:

1. 在 `hall/games.config.js` 注册;
2. 若为 JS 小游戏 → 实现 `GameModule`(服务端)+ `HallGames`(前端);
3. 若已有独立网页游戏 → 只需提供启动命令,大厅自动分配端口并 iframe 嵌入。

## 设计原则

- 大厅只管**房间 / 会话 / 路由**,不含任何游戏规则;
- 游戏通过**统一适配器接口**挂载,新增游戏不改大厅核心;
- 游戏消息与大厅控制消息**完全隔离**,游戏协议自定。
