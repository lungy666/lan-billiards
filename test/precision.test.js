'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../physics');
const ball = (id, x, y, vx = 0, vy = 0, wz = 0) =>
  ({ id, x, y, vx, vy, wx: -vy / P.R, wy: vx / P.R, wz, potted: false });
const energy = b => 0.5 * (b.vx ** 2 + b.vy ** 2) + 0.2 * P.R ** 2 * (b.wx ** 2 + b.wy ** 2 + b.wz ** 2);

test('side spin cushion collision dissipates energy and mirrored spin gives mirrored rebound', () => {
  const outcomes = [];
  for (const spin of [-100, 100]) {
    const b = ball(0, P.R - 0.01, 250, -100, 0, spin);
    const before = energy(b);
    P.step([b], 0);
    assert.ok(energy(b) < before);
    assert.ok(Math.abs(b.wz) < Math.abs(spin));
    outcomes.push(b.vy);
  }
  assert.equal(outcomes[0], -outcomes[1]);
});

test('ball friction removes small tangential slip without reversing it', () => {
  const a = ball(0, 200, 250, 100), b = ball(1, 222.3, 250, 0, 1);
  P.step([a, b], 0);
  const slip = b.vy - a.vy - P.R * (a.wz + b.wz);
  assert.ok(Math.abs(slip) < 1e-10);
});

test('high and low hits create follow and draw after a close straight collision', () => {
  const result = [];
  for (const offset of [-0.5, 0.5]) {
    const balls = [ball(0, 250, 250), ball(1, 295, 250)];
    P.strike(balls[0], 0, 0.45, 0, offset);
    for (let i = 0; i < 24; i++) P.step(balls, 1 / 60);
    result.push(balls[0].vx);
  }
  assert.ok(result[0] < 0, 'low strike draws back');
  assert.ok(result[1] > 0, 'high strike follows forward');
});

test('preview is deterministic, leaves live balls unchanged and matches solver samples', () => {
  const balls = [ball(0, 250, 250), ball(1, 370, 261)];
  const original = JSON.stringify(balls), off = [0.2, -0.3];
  const paths = P.predict(balls, 0, 0.45, off, 30);
  assert.equal(JSON.stringify(balls), original);
  assert.deepEqual(paths, P.predict(balls, 0, 0.45, off, 30));
  const copy = structuredClone(balls);
  P.strike(copy[0], 0, 0.45, ...off);
  for (let i = 0; i < 30; i++) P.step(copy, 1 / 60);
  const end = paths.find(p => p.id === 0).points.at(-1);
  assert.ok(Math.hypot(end[0] - copy[0].x, end[1] - copy[0].y) <= 1);
});

test('fast cut shot is stable when timestep is refined', () => {
  const angles = [];
  for (const dt of [1 / 60, 1 / 960]) {
    const balls = [ball(0, 200, 250, 1600), ball(1, 400, 265)];
    for (let t = 0; t < 0.2; t += dt) {
      if (P.step(balls, dt).some(e => e.k === 'hit')) {
        angles.push(Math.atan2(balls[0].vy, balls[0].vx));
        break;
      }
    }
  }
  assert.equal(angles.length, 2);
  assert.ok(Math.abs(angles[0] - angles[1]) * 180 / Math.PI < 1);
});
