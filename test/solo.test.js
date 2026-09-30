'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const P = require('../physics');
const AI = require('../ai');

function harness() {
  let connect, now = 0;
  const timers = new Map();
  const root = path.join(__dirname, '..');
  const realRequire = createRequire(path.join(root, 'server.js'));
  const sandbox = {
    require(name) {
      if (name === 'http') return { createServer: () => ({ listen() {} }) };
      if (name === './wslib') return { attach(server, fn) { connect = fn; } };
      return realRequire(name);
    },
    __dirname: root, process: { env: {} }, console, URL,
    Date: { now: () => now },
    setInterval(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), sandbox);
  return {
    timers,
    join(solo, name) {
      const messages = [];
      const c = { open: true, alive: true, send(s) { messages.push(JSON.parse(s)); }, ping() {},
        close() { this.open = false; this.onclose(); } };
      connect(c, { url: '/ws?test=1' + (solo ? '&mode=solo' : '') });
      c.message = obj => c.onmessage(JSON.stringify(obj));
      c.message({ t: 'hello', name });
      c.messages = messages;
      c.room = () => messages.filter(m => m.t === 'room' || m.t === 'welcome').at(-1);
      return c;
    },
    tick(n) { for (let i = 0; i < n; i++) { now += 16; for (const { fn, ms } of timers.values()) if (ms === 16) fn(); } },
  };
}

test('solo rooms are isolated, PvP still starts with two humans, timers cleaned on leave', () => {
  const h = harness();
  const a = h.join(true, 'A'), b = h.join(true, 'B');
  assert.equal(a.room().phase, 'aiming');
  assert.equal(a.room().players[1].bot, true);
  assert.equal(b.room().players[0].name, 'B');
  const p = h.join(false, 'P');
  assert.equal(p.room().phase, 'lobby');
  h.join(false, 'Q');
  assert.equal(p.room().phase, 'aiming');
  assert.equal(p.room().players[1].bot, false);
  const before = h.timers.size;
  a.close();
  assert.equal(h.timers.size, before - 2);
  assert.equal(b.room().phase, 'aiming');
});

test('human foul gives computer ball in hand and computer takes its turn', () => {
  const h = harness(), c = h.join(true, 'A');
  c.message({ t: 'shoot', a: Math.PI, p: 0.04 });
  h.tick(1200);
  assert.ok(c.messages.some(m => m.t === 'room' && m.phase === 'placing' && m.turn === 1));
  assert.ok(c.messages.some(m => m.t === 'room' && m.phase === 'sim' && m.turn === 1));
  assert.ok(c.messages.filter(m => m.t === 'cuestrike').length >= 2);
});

test('early black pot ends game and solo rematch needs only human consent', () => {
  const h = harness(), c = h.join(true, 'A');
  // First finish a harmless opening shot, then arrange a premature black pot.
  c.message({ t: 'shoot', a: Math.PI, p: 0.04 });
  h.tick(1200);
  // Wait for the computer to finish so the human can take the next shot.
  for (let i = 0; i < 3000 && c.room().turn !== 0; i++) h.tick(1);
  assert.equal(c.room().turn, 0);
  const balls = P.rack().map(b => [b.id, b.x, b.y, 1]);
  balls[0] = [0, 500, 90, 0];
  const black = balls.find(b => b[0] === 8);
  black[1] = 500; black[2] = 35; black[3] = 0;
  c.message({ t: 'test', cmd: 'set', balls });
  c.message({ t: 'shoot', a: -Math.PI / 2, p: 0.2 });
  h.tick(1200);
  assert.equal(c.room().phase, 'over');
  c.message({ t: 'rematch' });
  assert.equal(c.room().phase, 'aiming');
  assert.equal(c.room().turn, 1);
  h.tick(70);
  assert.equal(c.room().phase, 'sim');
});

test('AI chooses legal groups, can aim at black when cleared, and places legally', () => {
  const balls = P.rack();
  assert.ok(P.validPlace(balls, AI.place(balls, 'solid').x, AI.place(balls, 'solid').y));
  for (const b of balls) if (b.id !== 0 && b.id !== 8) b.potted = true;
  for (const group of ['solid', 'stripe', null]) {
    const shot = AI.chooseShot(balls, group);
    assert.ok(Number.isFinite(shot.a));
    assert.ok(shot.p >= 0.04 && shot.p <= 1);
  }
});
