/*
 * hall/adapters/index.js —— 适配器工厂
 * 把"房间"与"游戏实现"解耦:房间只信任统一接口,不关心游戏跑在哪里。
 */
'use strict';
const InProcessAdapter = require('./inprocess');
const ExternalAdapter = require('./external');

function createAdapter(room, def) {
  if (def && def.mode === 'external') return new ExternalAdapter(room, def);
  return new InProcessAdapter(room, def);
}

module.exports = { createAdapter, InProcessAdapter, ExternalAdapter };
