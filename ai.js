'use strict';
const P = require('./physics');

function targets(balls, group) {
  const cleared = group && P.groupCleared(balls, group);
  return balls.filter(b => !b.potted && b.id !== 0 &&
    (cleared ? b.id === 8 : b.id !== 8 && (!group || P.ballType(b.id) === group)));
}

function clearPath(balls, from, to, excluded) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length2 = dx * dx + dy * dy;
  if (!length2) return false;
  return balls.every(b => {
    if (b.potted || excluded.includes(b.id)) return true;
    const t = Math.max(0, Math.min(1, ((b.x - from.x) * dx + (b.y - from.y) * dy) / length2));
    return Math.hypot(b.x - from.x - t * dx, b.y - from.y - t * dy) > 2 * P.R + 0.5;
  });
}

function chooseShot(balls, group, isBreak = false) {
  const cue = balls.find(b => b.id === 0);
  const legal = targets(balls, group);
  if (isBreak) {
    const front = legal.reduce((a, b) => a.x < b.x ? a : b);
    return { a: Math.atan2(front.y - cue.y, front.x - cue.x), p: 0.95 };
  }
  let best = null;
  for (const ball of legal) {
    for (const pocket of P.POCKETS) {
      const distance = Math.hypot(pocket.x - ball.x, pocket.y - ball.y);
      const nx = (pocket.x - ball.x) / distance, ny = (pocket.y - ball.y) / distance;
      // Aim at the cue-ball center position at contact, not the object-ball center.
      const ghost = { x: ball.x - 2 * P.R * nx, y: ball.y - 2 * P.R * ny };
      if (ghost.x < P.R || ghost.x > P.W - P.R || ghost.y < P.R || ghost.y > P.H - P.R) continue;
      const travel = Math.hypot(ghost.x - cue.x, ghost.y - cue.y);
      if (travel < 0.001) continue;
      const cut = ((ghost.x - cue.x) * nx + (ghost.y - cue.y) * ny) / travel;
      if (cut < 0.35 || !clearPath(balls, cue, ghost, [0, ball.id]) ||
          !clearPath(balls, ball, pocket, [0, ball.id])) continue;
      const score = cut * 1000 - travel - distance * 0.7;
      const speed = Math.sqrt(2 * P.PARAMS.ROLL_A * (travel + distance / (cut * cut))) * 1.25;
      const shot = { a: Math.atan2(ghost.y - cue.y, ghost.x - cue.x),
        p: Math.max(0.12, Math.min(0.85, (speed - 180) / 1420)), score };
      if (!best || score > best.score) best = shot;
    }
  }
  if (best) return { a: best.a, p: best.p };
  // If no pot is available, prefer a visible legal ball for a defensive hit.
  const ordered = legal.slice().sort((a, b) => Math.hypot(a.x - cue.x, a.y - cue.y) - Math.hypot(b.x - cue.x, b.y - cue.y));
  const ball = ordered.find(b => clearPath(balls, cue, b, [0, b.id])) || ordered[0];
  return ball ? { a: Math.atan2(ball.y - cue.y, ball.x - cue.x), p: 0.5 } : { a: 0, p: 0.3 };
}

function place(balls, group) {
  for (const ball of targets(balls, group)) {
    for (const pocket of P.POCKETS) {
      const d = Math.hypot(ball.x - pocket.x, ball.y - pocket.y);
      const spot = { x: ball.x + (ball.x - pocket.x) / d * 80, y: ball.y + (ball.y - pocket.y) / d * 80 };
      if (P.validPlace(balls, spot.x, spot.y) && clearPath(balls, spot, ball, [0, ball.id]) &&
          clearPath(balls, ball, pocket, [0, ball.id])) return spot;
    }
  }
  for (let x = 2 * P.R; x < P.W - P.R; x += 2 * P.R) {
    for (let y = 2 * P.R; y < P.H - P.R; y += 2 * P.R) {
      if (P.validPlace(balls, x, y)) return { x, y };
    }
  }
  throw new Error('No valid cue-ball placement');
}

module.exports = { chooseShot, place };
