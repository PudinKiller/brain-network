'use strict';
/* Brain Network — a living map of the vault's brains.
   Data lives in the notes, so agents and the plugin read the same thing:
   - a brain is a note with `brain: <name>` (its front page); `brain-parents` links its parent brains' front pages;
   - an item is a note inside a brain folder with `brain-state` (owner | claude | codex | done | planned | parked),
     or an entry of a `brain-plan` list in any note of that brain;
   - owner replies are written into the item note and appended to replies.jsonl, which hooks/replies.cjs hands to
     Claude Code on the next prompt. */
const { Plugin, ItemView, Component, Notice, Modal, Menu, PluginSettingTab, Setting, MarkdownRenderer, setIcon } = require('obsidian');
const fs = require('fs');
const nodePath = require('path');

const VIEW = 'brain-network-view';
const STATE = {
  owner: { label: 'Waiting on you', short: 'You' },
  claude: { label: 'Waiting on Claude', short: 'Claude' },
  codex: { label: 'Queued for Codex', short: 'Codex' },
  done: { label: 'Finished', short: 'Done' },
  planned: { label: 'Planned', short: 'Planned' },
  parked: { label: 'Parked', short: 'Parked' },
};
const STATE_ORDER = ['owner', 'claude', 'codex', 'done', 'planned', 'parked'];
const FRESH_LABEL = { owner: 'NEEDS YOU', claude: 'WITH CLAUDE', codex: 'FOR CODEX', done: 'DONE', planned: 'PLANNED', parked: 'PARKED' };
const GATE = { art: 'Art gate', decision: 'Decision', look: 'Look check', approval: 'Approval' };
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const VID_RE = /\.(mp4|webm|mov|m4v)$/i;
const LIVE_MS = 20 * 60 * 1000;
const MOONS_MAX = 18;

/* ------------------------------------------------------------------ model */
const list = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
function linkTarget(s) {
  s = String(s).trim();
  const m = s.match(/^\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]$/);
  return m ? m[1].trim() : s;
}
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}
const stemTitle = (b) => b.replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
function normState(s) {
  s = String(s || '').toLowerCase().trim();
  if (s === 'you' || s === 'me') return 'owner';
  if (s === 'queued') return 'codex';
  return STATE[s] ? s : 'planned';
}
function countStates(items) {
  const c = { owner: 0, claude: 0, codex: 0, done: 0, planned: 0, parked: 0 };
  items.forEach((i) => c[i.state]++);
  return c;
}

function buildModel(app) {
  const mc = app.metadataCache;
  const files = app.vault.getMarkdownFiles();
  const brains = [];
  const byBrain = new Map();
  for (const f of files) {
    const fm = mc.getFileCache(f)?.frontmatter;
    if (!fm || !fm.brain) continue;
    const b = {
      id: f.path, name: String(fm.brain), file: f.path, folder: f.parent ? f.parent.path : '',
      kind: String(fm['brain-kind'] || 'brain'), parentRefs: list(fm['brain-parents']),
      streams: list(fm['brain-streams']).map(String), parents: [], children: [], items: [], tasks: 0,
    };
    if (b.folder === '/') b.folder = '';
    brains.push(b);
    byBrain.set(f.path, b);
  }
  for (const b of brains) {
    for (const r of b.parentRefs) {
      const dest = mc.getFirstLinkpathDest(linkTarget(r), b.file);
      if (dest && byBrain.has(dest.path) && dest.path !== b.id && !b.parents.includes(dest.path)) {
        b.parents.push(dest.path);
        byBrain.get(dest.path).children.push(b.id);
      }
    }
  }
  const deepest = brains.slice().sort((a, b) => b.folder.length - a.folder.length);
  const ownerOf = (p) => deepest.find((b) => b.folder === '' || p === b.folder || p.startsWith(b.folder + '/'));

  const items = [];
  const byPath = new Map(), broken = [];
  for (const f of files) {
    const cache = mc.getFileCache(f), fm = cache?.frontmatter;
    /* a front matter block Obsidian could not parse (a duplicate key, a stray quote): its items vanish, so say so */
    if (!fm && cache?.sections?.[0]?.type === 'yaml') { const b = ownerOf(f.path); if (b) broken.push({ path: f.path, brain: b.id }); continue; }
    if (!fm || !(fm['brain-state'] || fm['brain-plan'])) continue;
    const b = ownerOf(f.path);
    if (!b) continue;
    if (fm['brain-state']) {
      const it = {
        id: f.path, title: fm['brain-title'] ? String(fm['brain-title']) : stemTitle(f.basename),
        state: normState(fm['brain-state']), gate: fm['brain-gate'] ? String(fm['brain-gate']) : null,
        stream: fm['brain-stream'] ? String(fm['brain-stream']) : 'General', afterRefs: list(fm['brain-after']),
        ask: fm['brain-ask'] ? String(fm['brain-ask']) : '', review: list(fm['brain-review']).map(String),
        date: dateStr(fm.date) || dateStr(fm.created), verified: fm['brain-verified'], file: f.path,
        brain: b.id, plan: false, status: fm.status ? String(fm.status) : '',
      };
      items.push(it); byPath.set(f.path, it); b.items.push(it);
    }
    const plan = fm['brain-plan'];
    if (Array.isArray(plan)) {
      plan.forEach((p, i) => {
        if (!p || typeof p !== 'object' || !p.title) return;
        const it = {
          id: f.path + '#plan:' + i, title: String(p.title), state: normState(p.state || 'planned'),
          gate: p.gate ? String(p.gate) : null, stream: p.stream ? String(p.stream) : 'General',
          afterRefs: list(p.after), ask: p.ask ? String(p.ask) : '', review: list(p.review).map(String),
          date: dateStr(p.date), verified: p.verified, file: f.path, link: p.link ? String(p.link) : null,
          brain: b.id, plan: true, planIndex: i, status: '',
        };
        items.push(it); b.items.push(it);
      });
    }
  }
  const byKey = new Map();
  for (const it of items) {
    byKey.set(it.brain + '|' + it.title.toLowerCase(), it);
    if (!it.plan) byKey.set(it.brain + '|' + it.file.split('/').pop().replace(/\.md$/, '').toLowerCase(), it);
  }
  for (const it of items) {
    it.after = [];
    for (const r of it.afterRefs) {
      const t = linkTarget(r);
      let dep = null;
      const dest = mc.getFirstLinkpathDest(t, it.file);
      if (dest && byPath.has(dest.path)) dep = byPath.get(dest.path);
      if (!dep) dep = byKey.get(it.brain + '|' + t.toLowerCase()) || byKey.get(it.brain + '|' + stemTitle(t).toLowerCase());
      if (dep && dep !== it && !it.after.includes(dep.id)) it.after.push(dep.id);
    }
  }
  for (const it of items) it.next = items.filter((o) => o.after.includes(it.id)).map((o) => o.id);
  for (const b of brains) {
    const c = mc.getFileCache(app.vault.getAbstractFileByPath(b.file));
    b.tasks = c && c.listItems ? c.listItems.filter((li) => li.task === ' ').length : 0;
  }
  const depth = new Map();
  const dep = (b, seen) => {
    if (depth.has(b.id)) return depth.get(b.id);
    if (seen.has(b.id)) return 1;
    seen.add(b.id);
    const d = b.parents.length ? 1 + Math.max(...b.parents.map((p) => dep(byBrain.get(p), seen))) : 1;
    depth.set(b.id, d);
    return d;
  };
  brains.forEach((b) => { b.level = dep(b, new Set()); b.counts = countStates(b.items); });
  return { brains, byBrain, items, byItem: new Map(items.map((i) => [i.id, i])), ownerOf, broken };
}

/* ----------------------------------------------------------------- layout */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function contactPass(N, need, R, yOnly) {
  for (let pass = 0; pass < 80; pass++) {
    let worst = 0;
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
      const a = N[i], b = N[j];
      const nd = need(a, b);
      if (!nd) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      if (yOnly) {
        if (Math.abs(dx) >= nd[0] || Math.abs(dy) >= nd[1]) continue;
        const p = (nd[1] - Math.abs(dy)) / 2, s = dy === 0 ? (R() < 0.5 ? -1 : 1) : Math.sign(dy);
        a.y -= s * p; b.y += s * p; worst = Math.max(worst, p);
        continue;
      }
      let d = Math.hypot(dx, dy);
      if (d >= nd) continue;
      if (d < 0.01) { dx = R() - 0.5; dy = R() - 0.5; d = Math.hypot(dx, dy) || 1; }
      const p = (nd - d) / 2;
      a.x -= dx / d * p; a.y -= dy / d * p; b.x += dx / d * p; b.y += dy / d * p;
      worst = Math.max(worst, p);
    }
    if (worst < 0.05) break;
  }
}
function topRadius(b) {
  const base = [0, 72, 56, 46, 40][Math.min(b.level, 4)];
  return base + Math.min(14, 2.4 * Math.sqrt(b.items.length)) - (b.kind === 'folder' ? 6 : 0);
}
/* Force pass after the living-brain recipe: pow(r,1.4) repulsion, degree-weighted centring, soft disc wall,
   then a positional contact pass. Parents sit above children so the arrows read downward. Seeded: same map
   every time for the same brains. */
function layoutTop(brains) {
  const R = rng(20261029), W = 1200, H = 900;
  const maxL = Math.max(1, ...brains.map((b) => b.level));
  const N = brains.map((b, i) => {
    const a = (i / Math.max(1, brains.length)) * Math.PI * 2 + R() * 0.3;
    return { id: b.id, r: topRadius(b), level: b.level, x: W / 2 + Math.cos(a) * (240 + R() * 90), y: H / 2 + (b.level - (maxL + 1) / 2) * 230 + Math.sin(a) * 60, vx: 0, vy: 0 };
  });
  const ix = new Map(N.map((n, i) => [n.id, i]));
  const E = [];
  brains.forEach((b) => b.parents.forEach((p) => ix.has(p) && E.push([ix.get(p), ix.get(b.id)])));
  const deg = N.map(() => 0);
  E.forEach(([a, b]) => { deg[a]++; deg[b]++; });
  N.forEach((n) => (n.m = Math.pow(n.r, 1.4) * 2.2));
  const ITER = 900;
  for (let it = 0; it < ITER; it++) {
    const cool = 1 - it / ITER;
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
      const a = N[i], b = N[j];
      let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = R() - 0.5; dy = R() - 0.5; d2 = 1; }
      const d = Math.sqrt(d2);
      let f = ((a.m + b.m) * 5.4) / d2;
      const gap = d - ((a.r + b.r) * 1.3 + 60);
      if (gap < 0) f += -gap * 0.5;
      a.vx -= (dx / d) * f; a.vy -= (dy / d) * f; b.vx += (dx / d) * f; b.vy += (dy / d) * f;
    }
    for (const [i, j] of E) {
      const a = N[i], b = N[j];
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const f = (d - (a.r + b.r + 130)) * 0.014;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    N.forEach((n, i) => {
      const c = 0.0012 + deg[i] * 0.0007;
      n.vx += (W / 2 - n.x) * c;
      const ty = H / 2 + (n.level - (maxL + 1) / 2) * 230;
      n.vy += (ty - n.y) * (deg[i] ? 0.02 : 0.003);
      const ddx = n.x - W / 2, ddy = (n.y - H / 2) * (W / H), dd = Math.hypot(ddx, ddy) || 1, Rw = W * 0.46;
      if (dd > Rw) { const p = (dd - Rw) * 0.05; n.vx -= (ddx / dd) * p; n.vy -= (ddy / dd) * p; }
      n.x += n.vx * 0.5 * cool; n.y += n.vy * 0.5 * cool; n.vx *= 0.8; n.vy *= 0.8;
    });
  }
  contactPass(N, (a, b) => a.r + b.r + 44, R);
  return Object.fromEntries(N.map((n) => [n.id, { x: n.x, y: n.y, r: n.r }]));
}

const LANE_TOP = 34, LANE_BOT = 12, LANE_GAP = 14, GAP_X = 58, GAP_NOW = 120, GAP_Y = 24, STACK = 4;
/* A strand reads left to right as time, laid out in layers so arrows always point right:
   1. Columns. Past run dates give the first columns; work without a date comes after them; anything planned, dated
      after today, or waiting on such work goes past the Now line. Every item sits at least one column right of
      everything it needs. A tall pile of unconnected chips in one lane is split over two columns.
   2. Columns are packed by their widest chip, not spaced by calendar distance, and chips are left-aligned in them.
   3. Lanes are rows. Within a lane, each column's chips are ordered to cut crossings (barycentre sweeps) and lined
      up with what they connect to in the same lane, with room between chips for the pills drawn above them.
   4. Lanes stack top to bottom without overlapping.
   `size` maps item id to its chip { w, h, lines }. */
function layoutStrand(brain, items, size) {
  const byId = new Map(items.map((i) => [i.id, i])), order = new Map(items.map((i, k) => [i.id, k]));
  const sz = (id) => size.get(id) || { w: 120, h: 29, lines: [''] };
  const d0 = new Date(), today = new Date(d0 - d0.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const deps = (it) => it.after.map((d) => byId.get(d)).filter(Boolean);
  const fut = new Map();
  const isFut = (it) => {
    if (fut.has(it.id)) return fut.get(it.id);
    fut.set(it.id, false);
    const f = (!it.date && it.state === 'planned') || (!!it.date && it.date > today) || deps(it).some(isFut);
    fut.set(it.id, f);
    return f;
  };
  items.forEach(isFut);
  const past = [...new Set(items.map((i) => i.date).filter((d) => d && d <= today))].sort();
  const later = [...new Set(items.map((i) => i.date).filter((d) => d && d > today))].sort();
  const pastIx = new Map(past.map((d, i) => [d, i])), K = past.length;
  const col = new Map(), visiting = new Set();
  let F0 = 0;
  const colOf = (it) => {
    if (col.has(it.id)) return col.get(it.id);
    let c = fut.get(it.id) ? F0 + (it.date > today ? later.indexOf(it.date) : 0)
      : it.date ? pastIx.get(it.date) : K - (it.state === 'parked' ? 0.4 : 0.5);
    if (visiting.has(it.id)) return c;
    visiting.add(it.id);
    for (const d of deps(it)) c = Math.max(c, colOf(d) + 1);
    visiting.delete(it.id); col.set(it.id, c);
    return c;
  };
  items.filter((i) => !fut.get(i.id)).forEach(colOf);
  F0 = col.size ? Math.max(...col.values()) + 1 : 0;
  items.filter((i) => fut.get(i.id)).forEach(colOf);

  const streams = brain.streams.slice();
  const seen = [...new Set(items.map((i) => i.stream))].sort((a, b) =>
    Math.min(...items.filter((i) => i.stream === a).map((i) => col.get(i.id))) - Math.min(...items.filter((i) => i.stream === b).map((i) => col.get(i.id))));
  for (const s of seen) if (!streams.includes(s)) streams.push(s);
  const used = streams.filter((s) => seen.includes(s));

  const N = items.map((it) => ({ id: it.id, it, ...sz(it.id), c: col.get(it.id), lane: it.stream, prev: [], next: [], x: 0, y: 0, ry: 0 }));
  const nOf = new Map(N.map((n) => [n.id, n]));
  N.forEach((n) => deps(n.it).forEach((d) => { const m = nOf.get(d.id); n.prev.push(m); m.next.push(n); }));
  const group = () => { const g = new Map(); N.forEach((n) => { const k = n.lane + '|' + n.c; if (!g.has(k)) g.set(k, []); g.get(k).push(n); }); return g; };
  /* a tall pile of chips that link to nothing in one lane and column: put the later half in a second column */
  for (const g of group().values()) {
    if (g.length <= STACK) continue;
    const loose = g.filter((n) => !n.prev.length && !n.next.length).sort((a, b) => order.get(a.id) - order.get(b.id));
    loose.slice(-Math.min(loose.length, Math.floor(g.length / 2))).forEach((n) => { n.c += 0.45; });
  }
  const cols = [...new Set([...N.map((n) => n.c), ...past.map((d, i) => i)])].sort((a, b) => a - b);
  const wOf = new Map(cols.map((k) => [k, 0]));
  N.forEach((n) => wOf.set(n.c, Math.max(wOf.get(n.c), n.w)));
  const hasFut = N.some((n) => fut.get(n.id)), hasNow = N.some((n) => !fut.get(n.id));
  const left = new Map();
  let x = 0, nowX = null;
  cols.forEach((k, i) => {
    if (i) {
      const cross = hasFut && k >= F0 && cols[i - 1] < F0;
      const gap = cross ? GAP_NOW : GAP_X;
      x += wOf.get(cols[i - 1]) + gap;
      if (cross) nowX = x - gap / 2;
    }
    left.set(k, x);
  });
  if (nowX === null) nowX = hasNow ? x + wOf.get(cols[cols.length - 1]) + 36 : -GAP_NOW / 2;
  N.forEach((n) => { n.x = left.get(n.c) + n.w / 2; });

  const groups = group(), laneNodes = new Map(used.map((s) => [s, []]));
  N.forEach((n) => laneNodes.get(n.lane).push(n));
  for (const g of groups.values()) g.sort((a, b) => order.get(a.id) - order.get(b.id));
  /* chips in order, each wanting its centre at d (or packed under the one above when d is null): place them as close
     to what they want as the gaps allow, merging runs that would overlap and centring each run on its wishes */
  const pack = (g, want) => {
    const blocks = [];
    let lastD = null;
    g.forEach((n, i) => {
      let d = want[i];
      if (d === null) d = lastD === null ? n.h / 2 : lastD + g[i - 1].h / 2 + GAP_Y + n.h / 2;
      lastD = d;
      blocks.push({ ns: [n], h: n.h, sum: d - n.h / 2, cnt: 1, top: d - n.h / 2 });
      while (blocks.length > 1) {
        const A = blocks[blocks.length - 2], B = blocks[blocks.length - 1];
        if (A.top + A.h + GAP_Y <= B.top) break;
        const off = A.h + GAP_Y;
        A.sum += B.sum - off * B.cnt; A.cnt += B.cnt; A.ns.push(...B.ns); A.h += GAP_Y + B.h; A.top = A.sum / A.cnt;
        blocks.pop();
      }
    });
    for (const B of blocks) { let y = B.top; for (const n of B.ns) { n.ry = y + n.h / 2; y += n.h + GAP_Y; } }
  };
  const laneOff = new Map();
  const stackLanes = () => {
    let top = 0;
    for (const s of used) {
      const ns = laneNodes.get(s);
      const r0 = Math.min(...ns.map((n) => n.ry - n.h / 2)), r1 = Math.max(...ns.map((n) => n.ry + n.h / 2));
      const off = top + LANE_TOP - r0;
      laneOff.set(s, off);
      ns.forEach((n) => { n.y = off + n.ry; });
      top = off + r1 + LANE_BOT + LANE_GAP;
    }
  };
  const mean = (a) => a.reduce((t, v) => t + v, 0) / a.length;
  for (const g of groups.values()) pack(g, g.map(() => null));
  stackLanes();
  for (let pass = 0; pass < 9; pass++) {
    const fwd = pass % 2 === 0, seq = fwd ? cols : cols.slice().reverse();
    for (const s of used) for (const k of seq) {
      const g = groups.get(s + '|' + k);
      if (!g) continue;
      const key = new Map(g.map((n) => {
        const side = fwd ? n.prev : n.next, ns = side.length ? side : n.prev.concat(n.next);
        return [n, ns.length ? mean(ns.map((m) => m.y)) : n.y];
      }));
      g.sort((a, b) => key.get(a) - key.get(b) || order.get(a.id) - order.get(b.id));
      pack(g, g.map((n) => { const same = n.prev.concat(n.next).filter((m) => m.lane === s); return same.length ? mean(same.map((m) => m.ry)) : null; }));
      g.forEach((n) => { n.y = laneOff.get(s) + n.ry; });
    }
    stackLanes();
  }
  const pos = Object.fromEntries(N.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h, lines: n.lines }]));
  const ticks = past.map((d, i) => ({ x: left.get(i) + wOf.get(i) / 2, label: new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }));
  return { pos, nowX, hasFuture: hasFut, ticks, bands: used.map((s) => ({ name: s })) };
}

/* ------------------------------------------------------------------ color */
function hexRgb(h) {
  h = (h || '').trim();
  if (h.startsWith('rgb')) { const m = h.match(/[\d.]+/g) || [0, 0, 0]; return [+m[0], +m[1], +m[2]]; }
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h || '888888', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round);
function wrapText(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fontFamily = (v, d) => (v && v.trim() && !v.includes('var(') ? v.trim() : d);
const CHIP_FONT = 12, CHIP_LH = 15, CHIP_TEXT_W = 132;
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
}

/* ------------------------------------------------------------------ stage */
class Stage {
  constructor(host, view) {
    this.view = view;
    this.canvas = host.createEl('canvas', { cls: 'bn-canvas' });
    this.ctx = this.canvas.getContext('2d');
    this.cam = { x: 0, y: 0, k: 1 };
    this.mode = 'top';
    this.alpha = 1;
    this.sel = null; this.hover = null; this.filter = null;
    this.particles = []; this.rings = [];
    this.t = 0; this.last = performance.now();
    this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.spring = new Set(); this.bursted = new Set();
    this.bindPointer();
    this.ro = new ResizeObserver(() => requestAnimationFrame(() => { if (this.dead) return; this.resize(); this.view.updateInsets(); }));
    this.ro.observe(host);
    this.resize();
    this.readColors();
    const loop = (now) => { if (this.dead) return; this.frame(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  destroy() { this.dead = true; this.ro.disconnect(); }
  readColors() {
    const cs = getComputedStyle(this.view.contentEl);
    const g = (name, fallback) => hexRgb(cs.getPropertyValue(name).trim() || fallback);
    // Interface text colours may be dark in a light Obsidian theme. This scene is always night.
    const nightText = (name, fallback, floor) => {
      const c = g(name, fallback);
      return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722 >= floor ? c : hexRgb(fallback);
    };
    this.C = {
      void: [6, 7, 13], bg: [11, 13, 23], dark: true,
      text: nightText('--text-normal', '#ececf4', 205),
      muted: nightText('--text-muted', '#a4aabe', 145),
      faint: nightText('--text-faint', '#68718b', 90),
      you: g('--bn-you', '#f2a24a'), claude: g('--bn-claude', '#a99dff'),
      codex: g('--bn-codex', '#4fd1bd'), done: g('--bn-done', '#6c7387'),
      planned: g('--bn-plan', '#737a8e'), parked: g('--bn-plan', '#737a8e'),
      base: g('--bn-base', '#7fa2d9'),
    };
    this.C.owner = this.C.you;
    this.F = fontFamily(cs.getPropertyValue('--font-interface'), '"Segoe UI", system-ui, sans-serif');
    this.FM = fontFamily(cs.getPropertyValue('--font-monospace'), 'Consolas, monospace');
    this.FS = fontFamily(cs.getPropertyValue('--font-text'), 'Georgia, serif');
    this.makeStars();
  }
  makeStars() {
    // All raster resources belong to this palette. No canvas is created by a draw method.
    const C = this.C, R = rng(0x51a7cafe), size = 768;
    const ratio = Math.min(2, Math.max(1, this.dpr || 1));
    const layers = [];
    for (let l = 0; l < 3; l++) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = Math.round(size * ratio);
      const g = tile.getContext('2d');
      g.scale(ratio, ratio);
      const count = [92, 44, 18][l];
      for (let i = 0; i < count; i++) {
        // An inset keeps a point from being cut by a tile seam.
        const x = 3 + R() * (size - 6), y = 3 + R() * (size - 6);
        const tint = R(), c = tint < 0.07 ? C.claude : tint < 0.12 ? [246, 211, 169] : [205, 218, 245];
        const radius = 0.28 + R() * [0.48, 0.62, 0.82][l];
        g.fillStyle = rgba(c, [0.24, 0.36, 0.55][l] * (0.45 + R() * 0.55));
        g.beginPath(); g.arc(x, y, radius, 0, Math.PI * 2); g.fill();
      }
      layers.push({ tile, pattern: this.ctx.createPattern(tile, 'repeat'), size, ratio,
        parallax: [0.05, 0.13, 0.25][l], zoom: [0.025, 0.055, 0.09][l] });
    }
    const glow = {};
    for (const key of ['you', 'claude', 'codex', 'base', 'text', 'done', 'planned', 'parked']) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 128;
      const g = tile.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, rgba(C[key], 1));
      grad.addColorStop(0.12, rgba(C[key], 0.64));
      grad.addColorStop(0.42, rgba(C[key], 0.18));
      grad.addColorStop(1, rgba(C[key], 0));
      g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
      glow[key] = tile;
    }
    glow.owner = glow.you;
    const sheen = document.createElement('canvas');
    sheen.width = 4; sheen.height = 128;
    const sg = sheen.getContext('2d'), wash = sg.createLinearGradient(0, 0, 0, 128);
    wash.addColorStop(0, 'rgba(224,233,255,0.055)');
    wash.addColorStop(0.42, 'rgba(224,233,255,0.012)');
    wash.addColorStop(1, 'rgba(224,233,255,0)');
    sg.fillStyle = wash; sg.fillRect(0, 0, 4, 128);
    const twinkles = Array.from({ length: 20 }, (_, i) => ({
      x: R(), y: R(), phase: R() * Math.PI * 2, speed: 0.3 + R() * 0.35,
      radius: i < 5 ? 2.1 + R() : 0.65 + R() * 0.55,
      color: i % 7 === 0 ? C.claude : i % 9 === 0 ? [246, 211, 169] : [218, 229, 251],
    }));
    this.stars = { layers, glow, sheen, twinkles };
  }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.W * this.dpr); this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = this.W + 'px'; this.canvas.style.height = this.H + 'px';
    if (!this.userMoved) this.needFit = true;
  }

  /* ---------- scenes ---------- */
  setTop(model, pos) {
    this.model = model;
    this.nodes = model.brains.map((b) => ({ id: b.id, b, ...pos[b.id] }));
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = [];
    model.brains.forEach((b) => b.parents.forEach((p) => this.byId.has(p) && this.edges.push({ a: p, b: b.id, bow: ((hash(p + b.id) % 2) ? 1 : -1) * 0.13 })));
  }
  setStrand(model, brain, lay) {
    this.model = model; this.brain = brain; this.lay = lay; this.spring.clear();
    this.nodes = brain.items.map((it) => {
      const p = lay.pos[it.id];
      return { id: it.id, it, x: p.x, y: p.y, w: p.w, h: p.h, lines: p.lines, r: p.h / 2 + 2, hx: p.x, hy: p.y };
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = [];
    brain.items.forEach((it) => it.after.forEach((d) => this.byId.has(d) && this.edges.push({ a: d, b: it.id, ay: 0, by: 0 })));
    /* several arrows on one chip leave or arrive at spread-out points, ordered by where the other end sits */
    const spread = (end, other, off) => {
      const at = new Map();
      this.edges.forEach((e) => { if (!at.has(e[end])) at.set(e[end], []); at.get(e[end]).push(e); });
      for (const [id, es] of at) {
        if (es.length < 2) continue;
        const h = this.byId.get(id).h, span = Math.min(h - 12, (es.length - 1) * 7);
        es.sort((p, q) => this.byId.get(p[other]).y - this.byId.get(q[other]).y);
        es.forEach((e, i) => { e[off] = -span / 2 + span * i / (es.length - 1); });
      }
    };
    spread('a', 'b', 'ay'); spread('b', 'a', 'by');
    this.streams = [];
    const byStream = new Map();
    this.nodes.forEach((n) => { const s = n.it.stream; if (!byStream.has(s)) byStream.set(s, []); byStream.get(s).push(n); });
    for (const b of lay.bands) if (byStream.has(b.name)) this.streams.push({ name: b.name, nodes: byStream.get(b.name) });
  }
  /* each frame: lane boxes follow the chips, so a chip held mid-drag stretches its lane */
  lanes() {
    const gutter = Math.min(...this.nodes.map((n) => n.x - n.w / 2)) - 16;
    return this.streams.map((s) => {
      let y0 = 1e9, y1 = -1e9, x1 = -1e9;
      for (const n of s.nodes) { y0 = Math.min(y0, n.y - n.h / 2); y1 = Math.max(y1, n.y + n.h / 2); x1 = Math.max(x1, n.x + n.w / 2); }
      return { name: s.name, nodes: s.nodes, x0: gutter, x1: x1 + 16, y0: y0 - LANE_TOP, y1: y1 + LANE_BOT };
    });
  }
  bounds() {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    if (!this.nodes.length) return [-200, -200, 200, 200];
    if (this.mode === 'strand') {
      for (const n of this.nodes) { a = Math.min(a, n.x - n.w / 2); b = Math.min(b, n.y - n.h / 2); c = Math.max(c, n.x + n.w / 2); d = Math.max(d, n.y + n.h / 2); }
      return [a - 30, b - 50, Math.max(c, this.lay.nowX) + 40, d + 56];
    }
    for (const n of this.nodes) { a = Math.min(a, n.x - n.r); b = Math.min(b, n.y - n.r); c = Math.max(c, n.x + n.r); d = Math.max(d, n.y + n.r); }
    return [a - 40, b - 40, c + 40, d + 40];
  }
  fitCam() {
    const [a, b, c, d] = this.bounds();
    const left = this.view.leftInset(), right = this.view.rightInset(), top = 60, bottom = this.view.bottomInset() + 28;
    const w = Math.max(200, this.W - left - right - 40), h = Math.max(200, this.H - top - bottom);
    const kW = w / (c - a), kH = h / (d - b);
    if (this.mode === 'top') { const k = Math.min(kW, kH, 1.25); return { k, x: left + 20 + w / 2 - ((a + c) / 2) * k, y: top + h / 2 - ((b + d) / 2) * k }; }
    /* a roadmap stays readable: never smaller than 1:1 just to fit its width. When it is wider than the
       screen, Today and what is planned stay in view and the history runs off to the left. */
    const k = Math.min(1.2, Math.max(kH, 0.92), Math.max(kW, 1));
    const x = (c - a) * k <= w ? left + 20 + w / 2 - ((a + c) / 2) * k : left + 20 + w - c * k;
    /* taller than the window: start at the top lane and scroll down for the rest */
    const y = (d - b) * k <= h ? top + h / 2 - ((b + d) / 2) * k : top - b * k;
    return { k, x, y };
  }
  tween(to, ms, alphaTo, done) {
    if (this.reduce) ms = 1;
    /* a camera move during a Galaxy/Roadmap switch waits for it, so the switch and its fade always finish */
    if (this.tw && this.tw.done && alphaTo == null && !done) { const prev = this.tw.done; this.tw.done = () => { prev(); this.tween(to, ms); }; return; }
    this.tw = { from: { ...this.cam }, to, t0: performance.now(), ms, a0: this.alpha, a1: alphaTo == null ? (this.tw ? this.tw.a1 : this.alpha) : alphaTo, done };
  }
  world(px, py) { return [(px - this.cam.x) / this.cam.k, (py - this.cam.y) / this.cam.k]; }
  hit(px, py) {
    const [x, y] = this.world(px, py);
    let best = null, bd = 1e9;
    for (const n of this.nodes || []) {
      if (n.w) {
        const pad = 4 / this.cam.k;
        if (Math.abs(n.x - x) < n.w / 2 + pad && Math.abs(n.y - y) < n.h / 2 + pad) { const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { best = n; bd = d; } }
        continue;
      }
      const d = Math.hypot(n.x - x, n.y - y), lim = Math.max(n.r + 8, 16 / this.cam.k);
      if (d < lim && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  /* ---------- pointer: deferred capture so click and dblclick still reach us ---------- */
  bindPointer() {
    const cv = this.canvas;
    let arm = null, lastClick = { id: null, t: 0 }, lastOpen = { id: null, t: 0 };
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const open = (id) => {
      const now = performance.now();
      if (id === lastOpen.id && now - lastOpen.t < 450) return;
      lastOpen = { id, t: now };
      this.view.onDouble(id);
    };
    cv.addEventListener('pointerdown', (e) => {
      this.view.contentEl.focus({ preventScroll: true });
      if (e.button !== 0) return;
      const [px, py] = local(e), n = this.hit(px, py);
      if (n) this.spring.delete(n.id);
      arm = { px, py, id: n ? n.id : null, moved: false, pid: e.pointerId, cx: this.cam.x, cy: this.cam.y, ox: n ? n.x : 0, oy: n ? n.y : 0 };
    });
    cv.addEventListener('pointermove', (e) => {
      const [px, py] = local(e);
      if (!arm) {
        const n = this.hit(px, py);
        const id = n ? n.id : null;
        if (id !== this.hover) { this.hover = id; cv.style.cursor = id ? 'pointer' : 'grab'; }
        return;
      }
      if (!arm.moved && Math.hypot(px - arm.px, py - arm.py) > 4) { arm.moved = true; cv.setPointerCapture(arm.pid); cv.style.cursor = 'grabbing'; }
      if (!arm.moved) return;
      if (arm.id) {
        const n = this.byId.get(arm.id);
        n.x = arm.ox + (px - arm.px) / this.cam.k; n.y = arm.oy + (py - arm.py) / this.cam.k;
      } else { this.cam.x = arm.cx + px - arm.px; this.cam.y = arm.cy + py - arm.py; this.userMoved = true; }
    });
    const up = (e) => {
      if (!arm) return;
      const a = arm; arm = null;
      if (cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      cv.style.cursor = this.hover ? 'pointer' : 'grab';
      if (a.moved) {
        /* strands arrange themselves: a dragged chip slides home on release. Brains keep where you put them. */
        if (a.id && this.mode === 'strand') this.spring.add(a.id);
        else if (a.id) this.view.onPin(a.id, this.byId.get(a.id));
        return;
      }
      if (!a.id) { this.view.onVoid(); return; }
      const now = performance.now();
      const dbl = lastClick.id === a.id && now - lastClick.t < 450;
      lastClick = { id: a.id, t: now };
      if (dbl) open(a.id); else this.view.onClick(a.id);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { arm = null; });
    cv.addEventListener('dblclick', (e) => { const [px, py] = local(e); const n = this.hit(px, py); if (n) open(n.id); });
    cv.addEventListener('pointerleave', () => { if (!arm && this.hover) { this.hover = null; } });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = local(e), w = this.world(px, py);
      const k2 = Math.min(3.4, Math.max(0.3, this.cam.k * Math.pow(0.9988, e.deltaY)));
      this.cam.x = px - w[0] * k2; this.cam.y = py - w[1] * k2; this.cam.k = k2; this.tw = null; this.userMoved = true;
    }, { passive: false });
  }

  /* ---------- fx ---------- */
  burst(id, colorKey, kind) {
    const n = this.byId && this.byId.get(id);
    if (!n || this.reduce) return;
    const c = this.C[colorKey] || this.C.base;
    if (kind === 'in') { this.rings.push({ x: n.x, y: n.y, r0: n.r * 4, r1: n.r, life: 0, max: 0.55, c }); return; }
    this.rings.push({ x: n.x, y: n.y, r0: n.r, r1: n.r * 6, life: 0, max: 0.8, c });
    this.rings.push({ x: n.x, y: n.y, r0: n.r, r1: n.r * 3.4, life: -0.12, max: 0.7, c: this.C.text });
    const R = rng(hash(id) + this.particles.length);
    for (let i = 0; i < 34; i++) {
      const a = R() * Math.PI * 2, v = 40 + R() * 160;
      this.particles.push({ x: n.x, y: n.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.6 + R() * 0.7, c: R() < 0.25 ? this.C.text : c, s: 1 + R() * 2.2 });
    }
  }
  curveTop(A, B, bow, t) {
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.max(Math.hypot(dx, dy), 1);
    const nx = -dy / L, ny = dx / L, cx = A.x + dx * 0.5 + nx * bow * L, cy = A.y + dy * 0.5 + ny * bow * L, m = 1 - t;
    return [m * m * A.x + 2 * m * t * cx + t * t * B.x, m * m * A.y + 2 * m * t * cy + t * t * B.y];
  }
  curveStrand(A, B, t, e) {
    const sx = A.x + A.w / 2, ex = B.x - B.w / 2 - 5, dx = Math.max(30, Math.abs(ex - sx) * 0.5), m = 1 - t;
    const ay = A.y + (e ? e.ay : 0), by = B.y + (e ? e.by : 0);
    const p0 = [sx, ay], p1 = [sx + dx, ay], p2 = [ex - dx, by], p3 = [ex, by];
    return [m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0],
      m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1]];
  }
  edgePoint(e, t) {
    const A = this.byId.get(e.a), B = this.byId.get(e.b);
    if (this.mode === 'strand') return this.curveStrand(A, B, t, e);
    const L = Math.hypot(B.x - A.x, B.y - A.y) || 1, t0 = A.r / L, t1 = 1 - (B.r + 10) / L;
    return this.curveTop(A, B, e.bow, t0 + (t1 - t0) * t);
  }
  edgeColorKey(e) {
    if (this.mode === 'strand') { const s = this.byId.get(e.b).it.state; return s === 'owner' ? 'you' : s; }
    const c = this.byId.get(e.b).b.counts;
    return c.owner ? 'you' : c.claude ? 'claude' : c.codex ? 'codex' : 'base';
  }
  /* ---------- frame ---------- */
  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now; this.t += dt;
    if (!this.view.contentEl.isShown() || document.hidden || !this.nodes) return;
    if (this.needFit && this.W > 80 && this.H > 80) { this.cam = this.fitCam(); this.needFit = false; }
    if (this.tw) {
      const p = Math.min(1, (now - this.tw.t0) / this.tw.ms), e = ease(p), f = this.tw.from, to = this.tw.to;
      this.cam = { x: f.x + (to.x - f.x) * e, y: f.y + (to.y - f.y) * e, k: f.k + (to.k - f.k) * e };
      this.alpha = this.tw.a0 + (this.tw.a1 - this.tw.a0) * e;
      if (p >= 1) { const d = this.tw.done; this.tw = null; d && d(); }
    }
    for (const id of this.spring) {
      const n = this.byId.get(id);
      if (!n || n.hx == null) { this.spring.delete(id); continue; }
      const k = this.reduce ? 1 : 1 - Math.pow(0.0008, dt);
      n.x += (n.hx - n.x) * k; n.y += (n.hy - n.y) * k;
      if (Math.hypot(n.hx - n.x, n.hy - n.y) < 0.3) { n.x = n.hx; n.y = n.hy; this.spring.delete(id); }
    }
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.drawBackdrop();
    ctx.setTransform(dpr * this.cam.k, 0, 0, dpr * this.cam.k, dpr * this.cam.x, dpr * this.cam.y);
    ctx.globalAlpha = this.alpha;
    if (this.mode === 'top') this.drawTop(dt); else this.drawStrand(dt);
    this.drawFx(dt);
    /* the Card and its Moons follow the selected node; their tethers are drawn here, in screen space */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1;
    this.view.overlayFrame(ctx);
  }
  /* the night sky: void, nebulae with parallax, three star layers, twinkles and a vignette (canvas art by Codex, October 30) */
  drawBackdrop() {
    const ctx = this.ctx, C = this.C, W = this.W, H = this.H, S = this.stars;
    const time = this.reduce ? 0 : this.t;
    ctx.save();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    const radius = Math.max(W, H);
    const voidLight = ctx.createRadialGradient(W * 0.48, H * 0.12, 0, W * 0.48, H * 0.12, radius);
    voidLight.addColorStop(0, '#0d0e1d'); voidLight.addColorStop(0.5, rgba(C.void, 1));
    voidLight.addColorStop(1, '#05060b');
    ctx.fillStyle = voidLight; ctx.fillRect(0, 0, W, H);
    const [x0, y0, x1, y1] = this.bounds();
    const anchorX = (this.cam.x + (x0 + x1) * 0.5 * this.cam.k - W * 0.5) * 0.35;
    const anchorY = (this.cam.y + (y0 + y1) * 0.5 * this.cam.k - H * 0.5) * 0.35;
    const cloudR = radius * 0.72 * Math.pow(this.cam.k, 0.06);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.055;
    ctx.drawImage(S.glow.claude, W * 0.32 + anchorX - cloudR, H * 0.2 + anchorY - cloudR, cloudR * 2, cloudR * 2);
    ctx.globalAlpha = 0.045;
    ctx.drawImage(S.glow.base, W * 0.73 + anchorX - cloudR, H * 0.5 + anchorY - cloudR, cloudR * 2, cloudR * 2);
    ctx.globalAlpha = 0.032;
    ctx.drawImage(S.glow.codex, W * 0.45 + anchorX - cloudR, H * 0.95 + anchorY - cloudR, cloudR * 2, cloudR * 2);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    for (const layer of S.layers) {
      const scale = Math.pow(this.cam.k, layer.zoom), period = layer.size * scale;
      const ox = ((this.cam.x * layer.parallax) % period + period) % period;
      const oy = ((this.cam.y * layer.parallax) % period + period) % period;
      const q = scale / layer.ratio;
      ctx.save(); ctx.translate(ox, oy); ctx.scale(q, q);
      ctx.fillStyle = layer.pattern;
      ctx.fillRect(-ox / q, -oy / q, W / q, H / q);
      ctx.restore();
    }
    for (let i = 0; i < S.twinkles.length; i++) {
      const star = S.twinkles[i], spanX = W + 40, spanY = H + 40;
      const x = ((star.x * spanX + this.cam.x * 0.19) % spanX + spanX) % spanX - 20;
      const y = ((star.y * spanY + this.cam.y * 0.19) % spanY + spanY) % spanY - 20;
      const a = this.reduce ? 0.65 : 0.53 + 0.2 * Math.sin(time * star.speed + star.phase);
      ctx.fillStyle = rgba(star.color, a);
      ctx.beginPath();
      if (i < 5) {
        const r = star.radius;
        ctx.moveTo(x, y - r); ctx.lineTo(x + 0.45, y - 0.45);
        ctx.lineTo(x + r * 0.8, y); ctx.lineTo(x + 0.45, y + 0.45);
        ctx.lineTo(x, y + r); ctx.lineTo(x - 0.45, y + 0.45);
        ctx.lineTo(x - r * 0.8, y); ctx.lineTo(x - 0.45, y - 0.45); ctx.closePath();
      } else ctx.arc(x, y, star.radius * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    const vignette = ctx.createRadialGradient(W * 0.5, H * 0.45, Math.min(W, H) * 0.2,
      W * 0.5, H * 0.45, Math.hypot(W, H) * 0.6);
    vignette.addColorStop(0, 'rgba(2,3,8,0)'); vignette.addColorStop(1, 'rgba(2,3,8,0.62)');
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  focusSet() {
    if (!this.sel || !this.byId.has(this.sel)) {
      if (this.mode === 'strand' && this.filter) return new Set(this.nodes.filter((n) => n.it.state === this.filter).map((n) => n.id));
      return null;
    }
    const keep = new Set([this.sel]);
    if (this.mode === 'top') { this.edges.forEach((e) => { if (e.a === this.sel) keep.add(e.b); if (e.b === this.sel) keep.add(e.a); }); return keep; }
    const walk = (id, dir) => { const it = this.byId.get(id).it; for (const n of (dir ? it.next : it.after)) if (this.byId.has(n) && !keep.has(n)) { keep.add(n); walk(n, dir); } };
    walk(this.sel, 0); walk(this.sel, 1);
    return keep;
  }
  arrow(x, y, ang, size, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(ang) * size, y + Math.sin(ang) * size);
    ctx.lineTo(x + Math.cos(ang + 2.5) * size * 0.8, y + Math.sin(ang + 2.5) * size * 0.8);
    ctx.lineTo(x + Math.cos(ang - 2.5) * size * 0.8, y + Math.sin(ang - 2.5) * size * 0.8);
    ctx.closePath(); ctx.fill();
  }
  strokeCurve(fn, n, width, color, dash) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const p = fn(i / n); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
  }
  /* the only moving lines: the selected or hovered node's links flow slowly and steadily in the handoff direction */
  flow(fn, color) {
    if (this.reduce) return;
    const ctx = this.ctx;
    ctx.lineDashOffset = -((this.t * 14) % 12);
    this.strokeCurve(fn, 32, 1.5, color, [2, 10]);
    ctx.lineDashOffset = 0;
  }

  drawTop(dt) {
    const ctx = this.ctx, C = this.C, keep = this.focusSet(), A0 = this.alpha;
    const P = this.view.plugin, time = this.reduce ? 0 : this.t, TAU = Math.PI * 2;
    ctx.save(); ctx.letterSpacing = '0px'; ctx.lineDashOffset = 0;
    for (const e of this.edges) {
      const on = !keep || (keep.has(e.a) && keep.has(e.b));
      const hot = e.a === this.sel || e.b === this.sel || e.a === this.hover || e.b === this.hover;
      ctx.globalAlpha = A0 * (on ? 1 : 0.15);
      const c = C[this.edgeColorKey(e)] || C.base, fn = (t) => this.edgePoint(e, t);
      this.strokeCurve(fn, 24, hot ? 5 : 3, rgba(c, hot ? 0.08 : 0.025));
      this.strokeCurve(fn, 24, hot ? 1.1 : 0.7, rgba(hot ? mix(c, C.text, 0.55) : c, hot ? 0.75 : 0.27));
      const p = fn(1), q = fn(0.96);
      this.arrow(p[0], p[1], Math.atan2(p[1] - q[1], p[0] - q[0]), 4.5, rgba(c, hot ? 0.85 : 0.4));
      if (hot) this.flow(fn, rgba(mix(c, C.text, 0.6), 0.8));
    }
    ctx.globalAlpha = A0;
    // Resolve item-to-brain status once, rather than scanning all items for every system.
    const freshCounts = new Map(), codexBrains = new Set();
    if (P.fresh) for (const id of P.fresh.keys()) {
      const it = P.model.byItem.get(id);
      if (it) freshCounts.set(it.brain, (freshCounts.get(it.brain) || 0) + 1);
    }
    if (P.codexLive) for (const id of P.codexLive.keys()) {
      const it = P.model.byItem.get(id); if (it) codexBrains.add(it.brain);
    }
    const order = this.nodes.slice().sort((a, b) => b.b.level - a.b.level);
    for (const n of order) {
      const b = n.b, cnt = b.counts, r = n.r;
      const opacity = A0 * (!keep || keep.has(n.id) ? 1 : 0.2);
      const key = cnt.owner ? 'you' : cnt.claude ? 'claude' : cnt.codex ? 'codex' : 'base';
      const c = C[key], hov = this.hover === n.id || this.sel === n.id;
      const breathe = key === 'you' && !this.reduce ? 0.83 + 0.17 * Math.sin(time * 1.2) : 1;
      ctx.globalAlpha = opacity * (key === 'you' ? 0.34 : 0.18) * breathe;
      ctx.drawImage(this.stars.glow[key], n.x - r * 1.8, n.y - r * 1.8, r * 3.6, r * 3.6);
      ctx.globalAlpha = opacity;
      ctx.fillStyle = rgba(mix(C.bg, c, 0.045), b.kind === 'folder' ? 0.57 : 0.88);
      ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.97, 0, TAU); ctx.fill();
      ctx.setLineDash(b.kind === 'folder' ? [2, 6] : []);
      ctx.strokeStyle = rgba(hov ? C.text : c, hov ? 0.65 : key === 'you' ? 0.43 : 0.27);
      ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, TAU); ctx.stroke();
      ctx.setLineDash([]); ctx.strokeStyle = rgba(c, 0.1); ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.79, 0, TAU); ctx.stroke();
      const phase = (hash(b.id) >>> 0) / 4294967296 * TAU;
      const direction = (hash(b.id) & 1) ? 1 : -1, items = b.items || [];
      for (let i = 0; i < items.length; i++) {
        const s = items[i].state, pc = C[s] || C.planned;
        const quiet = s === 'done' || s === 'parked';
        const a = phase + i * TAU / items.length + direction * time * 0.012;
        const px = n.x + Math.cos(a) * r, py = n.y + Math.sin(a) * r;
        const pr = s === 'owner' ? 3 : quiet ? 1.25 : 1.9;
        if (s === 'owner') {
          ctx.globalAlpha = opacity * 0.62 * breathe;
          ctx.drawImage(this.stars.glow.you, px - 10, py - 10, 20, 20);
        }
        ctx.globalAlpha = opacity;
        ctx.fillStyle = rgba(pc, quiet ? 0.4 : s === 'planned' ? 0.57 : 0.98);
        ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
      }
      const lv = (P.live && P.live.brains.get(n.id)) || P.runningIn(n.id) || codexBrains.has(n.id);
      if (lv) {
        const rot = time * 0.45 - Math.PI / 2;
        ctx.lineWidth = 1; ctx.strokeStyle = rgba(C.claude, 0.7);
        ctx.setLineDash([2, 7]); ctx.beginPath(); ctx.arc(n.x, n.y, r + 13, rot, rot + TAU * 0.78); ctx.stroke();
        ctx.setLineDash([]);
        const ox = n.x + Math.cos(rot + TAU * 0.78) * (r + 13);
        const oy = n.y + Math.sin(rot + TAU * 0.78) * (r + 13);
        ctx.drawImage(this.stars.glow.claude, ox - 7, oy - 7, 14, 14);
        ctx.fillStyle = rgba(C.text, 0.9); ctx.beginPath(); ctx.arc(ox, oy, 1.3, 0, TAU); ctx.fill();
      }
      if (this.sel === n.id) {
        ctx.strokeStyle = rgba(C.text, 0.6); ctx.lineWidth = 0.8;
        ctx.setLineDash([1, 4]); ctx.beginPath(); ctx.arc(n.x, n.y, r + 20, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      }
      if (this.dropId === n.id) {
        ctx.globalAlpha = A0 * 0.3;
        ctx.drawImage(this.stars.glow.claude, n.x - r * 1.6, n.y - r * 1.6, r * 3.2, r * 3.2);
        ctx.globalAlpha = A0; ctx.strokeStyle = rgba(C.claude, 1); ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]); ctx.lineDashOffset = -time * 12;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 26, 0, TAU); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.globalAlpha = opacity;
      }
      const fs = b.level === 1 ? 19 : b.level === 2 ? 16 : b.level === 3 ? 14 : 13;
      ctx.font = `500 ${fs}px ${this.FS}`; ctx.letterSpacing = '0px';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lines = wrapText(ctx, b.name, r * 1.5, 2);
      const sub = cnt.owner ? `${cnt.owner} WAITING ON YOU` : cnt.claude ? `${cnt.claude} WITH CLAUDE` :
        cnt.codex ? `${cnt.codex} WITH CODEX` : b.tasks ? `${b.tasks} OPEN TASKS` :
        items.length ? `${items.length} ITEMS` : b.kind === 'folder' ? 'FOLDER' : 'STAR SYSTEM';
      const lh = fs * 1.18, y0 = n.y - (lines.length - 1) * lh / 2 - 4;
      const cy = y0 - fs * 0.65 - 12;
      ctx.globalAlpha = opacity * 0.75;
      ctx.drawImage(this.stars.glow[key], n.x - 13, cy - 13, 26, 26);
      ctx.globalAlpha = opacity; ctx.fillStyle = rgba(mix(c, C.text, 0.6), 1);
      ctx.beginPath(); ctx.arc(n.x, cy, key === 'you' ? 2.9 : 2.2, 0, TAU); ctx.fill();
      // The core has a short, precise diffraction cross rather than a large flare.
      ctx.strokeStyle = rgba(c, 0.4); ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(n.x - 6, cy); ctx.lineTo(n.x + 6, cy);
      ctx.moveTo(n.x, cy - 6); ctx.lineTo(n.x, cy + 6); ctx.stroke();
      ctx.fillStyle = rgba(C.text, 1);
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], n.x, y0 + i * lh);
      ctx.font = `500 ${Math.max(8, fs * 0.56)}px ${this.F}`; ctx.letterSpacing = '1px';
      ctx.fillStyle = rgba(cnt.owner ? C.you : C.muted, 1);
      // Compress unusually long subtitles to the interior width without changing layout.
      ctx.fillText(sub, n.x, y0 + (lines.length - 1) * lh + fs * 1.05, r * 1.6);
      ctx.letterSpacing = '0px';
      const nf = freshCounts.get(n.id) || 0;
      if (nf) {
        const bx = n.x - r * 0.74, by = n.y - r * 0.74;
        const pulse = this.reduce ? 0.65 : 0.65 + 0.2 * Math.sin(time * 3.2);
        ctx.globalAlpha = opacity * pulse;
        ctx.drawImage(this.stars.glow.claude, bx - 21, by - 21, 42, 42);
        ctx.globalAlpha = opacity; ctx.fillStyle = rgba(C.claude, 1);
        ctx.beginPath(); ctx.arc(bx, by, 12, 0, TAU); ctx.fill();
        ctx.fillStyle = rgba(C.void, 1); ctx.font = `700 10.5px ${this.FM}`;
        ctx.fillText('+' + nf, bx, by + 0.5);
      }
      if (cnt.owner) {
        const bx = n.x + r * 0.74, by = n.y - r * 0.74;
        ctx.fillStyle = rgba(C.you, 1); ctx.beginPath(); ctx.arc(bx, by, 12, 0, TAU); ctx.fill();
        ctx.fillStyle = rgba(C.void, 1); ctx.font = `700 11px ${this.FM}`;
        ctx.fillText(String(cnt.owner), bx, by + 0.5);
      }
    }
    ctx.restore(); ctx.globalAlpha = A0;
  }
  /* An item is a bubble: the title is always readable, the colour says who holds it. */
  drawChip(n, dim) {
    const ctx = this.ctx, C = this.C, it = n.it, s = it.state;
    const x0 = n.x - n.w / 2, y0 = n.y - n.h / 2, radius = n.h / 2;
    const col = C[s] || C.planned, quiet = s === 'done' || s === 'parked';
    const active = s === 'owner' || s === 'claude' || s === 'codex';
    ctx.save(); ctx.letterSpacing = '0px';
    if (active && !dim) {
      const breathe = s === 'owner' && !this.reduce ? 0.82 + 0.18 * Math.sin(this.t * 1.2) : 1;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * (s === 'owner' ? 0.28 : 0.13) * breathe;
      ctx.drawImage(this.stars.glow[s], x0 - 24, y0 - 20, n.w + 48, n.h + 40);
      ctx.globalAlpha = a;
    }
    rrect(ctx, x0, y0, n.w, n.h, radius);
    ctx.fillStyle = rgba(mix(C.bg, col, s === 'owner' ? 0.15 : quiet ? 0.035 : 0.075), s === 'planned' ? 0.34 : quiet ? 0.8 : 0.93);
    ctx.fill();
    ctx.save(); ctx.clip();
    ctx.drawImage(this.stars.sheen, x0, y0, n.w, n.h);
    ctx.restore();
    const rim = ctx.createLinearGradient(0, y0, 0, y0 + n.h);
    rim.addColorStop(0, rgba(mix(col, C.text, 0.35), quiet ? 0.24 : s === 'owner' ? 0.94 : 0.64));
    rim.addColorStop(0.48, rgba(col, quiet ? 0.16 : s === 'owner' ? 0.65 : 0.34));
    rim.addColorStop(1, rgba(col, quiet ? 0.08 : 0.15));
    ctx.strokeStyle = rim; ctx.lineWidth = s === 'owner' ? 1.2 : 0.8;
    if (s === 'planned' || s === 'parked') ctx.setLineDash([3, 4]);
    rrect(ctx, x0, y0, n.w, n.h, radius); ctx.stroke(); ctx.setLineDash([]);
    const mx = x0 + 13, my = y0 + 14.5;
    if (active) {
      const a = ctx.globalAlpha; ctx.globalAlpha = a * 0.65;
      ctx.drawImage(this.stars.glow[s], mx - 10, my - 10, 20, 20); ctx.globalAlpha = a;
    }
    ctx.lineWidth = 1.35;
    if (s === 'owner') {
      ctx.fillStyle = rgba(C.you, 1); ctx.beginPath();
      if (it.gate === 'art') {
        ctx.moveTo(mx, my - 4.7); ctx.lineTo(mx + 4.7, my); ctx.lineTo(mx, my + 4.7); ctx.lineTo(mx - 4.7, my); ctx.closePath();
      } else if (it.gate === 'decision' || it.gate === 'approval') rrect(ctx, mx - 3.8, my - 3.8, 7.6, 7.6, 1.5);
      else ctx.arc(mx, my, 3.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (s === 'done') {
      ctx.strokeStyle = rgba(C.muted, 1); ctx.beginPath();
      ctx.moveTo(mx - 3.5, my); ctx.lineTo(mx - 1, my + 2.8); ctx.lineTo(mx + 4, my - 3); ctx.stroke();
    } else if (s === 'codex') {
      ctx.fillStyle = rgba(C.codex, 1); ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + Math.PI / 6;
        ctx[i ? 'lineTo' : 'moveTo'](mx + Math.cos(a) * 4, my + Math.sin(a) * 4);
      }
      ctx.closePath(); ctx.fill();
    } else if (s === 'claude') {
      ctx.fillStyle = rgba(C.claude, 1); ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = rgba(s === 'parked' ? C.faint : C.planned, 1);
      ctx.beginPath(); ctx.arc(mx, my, 3.2, 0, Math.PI * 2); ctx.stroke();
    }
    if (it.gate && s !== 'owner' && s !== 'done' && s !== 'parked') {
      const gx = x0 + n.w - 10, gy = y0 + 10, g = 3;
      ctx.strokeStyle = rgba(C.you, 0.9); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(gx, gy - g); ctx.lineTo(gx + g, gy);
      ctx.lineTo(gx, gy + g); ctx.lineTo(gx - g, gy); ctx.closePath(); ctx.stroke();
    }
    ctx.font = `${s === 'owner' || this.sel === n.id ? 600 : 500} ${CHIP_FONT}px ${this.F}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(quiet ? C.muted : C.text, 1);
    (n.lines || [it.title]).forEach((line, i) => ctx.fillText(line, x0 + 24, y0 + 14.5 + i * CHIP_LH));
    ctx.restore();
  }
  drawStrand(dt) {
    const ctx = this.ctx, C = this.C, keep = this.focusSet(), A0 = this.alpha, lay = this.lay;
    const P = this.view.plugin, time = this.reduce ? 0 : this.t;
    const [bx0, by0, bx1, by1] = this.bounds(), top = by0 + 18, bot = by1 - 30;
    ctx.save(); ctx.letterSpacing = '0px'; ctx.lineDashOffset = 0; ctx.globalAlpha = A0;
    if (lay.hasFuture) {
      const field = ctx.createLinearGradient(lay.nowX, 0, Math.max(lay.nowX + 1, bx1), 0);
      field.addColorStop(0, rgba(C.base, 0)); field.addColorStop(1, rgba(C.base, 0.025));
      ctx.fillStyle = field; ctx.fillRect(lay.nowX, top, Math.max(0, bx1 - lay.nowX), bot - top);
    }
    ctx.font = `500 10px ${this.FM}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const tick of lay.ticks || []) {
      if (tick.x > lay.nowX - 20) continue;
      ctx.fillStyle = rgba(C.base, 0.065); ctx.fillRect(tick.x - 0.35, top, 0.7, bot - top);
      ctx.fillStyle = rgba(C.muted, 0.9); ctx.fillText(tick.label, tick.x, bot + 11);
    }
    // Recompute bounds from the live chip positions, including a chip held during a drag.
    const lanes = this.lanes(), viewLeft = (this.view.leftInset() + 10 - this.cam.x) / this.cam.k;
    ctx.font = `600 10px ${this.F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.letterSpacing = '1.8px';
    for (const L of lanes) {
      const on = !keep || L.nodes.some((n) => keep.has(n.id));
      ctx.globalAlpha = A0 * (on ? 1 : 0.4);
      const band = ctx.createLinearGradient(L.x0, 0, L.x1, 0);
      band.addColorStop(0, rgba(C.base, 0)); band.addColorStop(0.12, rgba(C.base, 0.045));
      band.addColorStop(0.75, rgba(C.base, 0.03)); band.addColorStop(1, rgba(C.base, 0));
      ctx.fillStyle = band; ctx.fillRect(L.x0, L.y0, L.x1 - L.x0, L.y1 - L.y0);
      const name = String(L.name).toUpperCase(), width = ctx.measureText(name).width;
      const lx = Math.max(L.x0 + 12, Math.min(Math.max(L.x0 + 12, viewLeft + 8), L.x1 - width - 12));
      ctx.fillStyle = rgba(C.muted, 1); ctx.fillText(name, lx, L.y0 + 12);
    }
    ctx.globalAlpha = A0; ctx.letterSpacing = '0px';
    const nowGlow = ctx.createLinearGradient(0, top, 0, bot);
    nowGlow.addColorStop(0, rgba(C.you, 0)); nowGlow.addColorStop(0.12, rgba(C.you, 0.055));
    nowGlow.addColorStop(0.88, rgba(C.you, 0.055)); nowGlow.addColorStop(1, rgba(C.you, 0));
    ctx.fillStyle = nowGlow; ctx.fillRect(lay.nowX - 4, top, 8, bot - top);
    ctx.fillStyle = rgba(C.you, 0.48); ctx.fillRect(lay.nowX - 0.4, top, 0.8, bot - top);
    ctx.fillStyle = rgba(C.you, 0.95); ctx.beginPath(); ctx.arc(lay.nowX, top + 2, 2, 0, Math.PI * 2); ctx.fill();
    ctx.font = `600 10px ${this.FM}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.letterSpacing = '0.7px';
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    ctx.fillText('TODAY · ' + date, lay.nowX, bot + 11);
    if (lay.hasFuture) {
      ctx.fillStyle = rgba(C.muted, 0.9); ctx.textAlign = 'left'; ctx.fillText('PLANNED →', lay.nowX + 18, top - 14);
    }
    ctx.letterSpacing = '0px';
    for (const e of this.edges) {
      const on = !keep || (keep.has(e.a) && keep.has(e.b)), hot = this.sel && keep && on;
      ctx.globalAlpha = A0 * (on ? 1 : 0.12);
      const fn = (t) => this.curveStrand(this.byId.get(e.a), this.byId.get(e.b), t, e);
      const c = hot ? C.text : mix(C.base, C[this.edgeColorKey(e)] || C.muted, 0.35);
      this.strokeCurve(fn, 24, hot ? 3.5 : 2.5, rgba(c, 0.035));
      this.strokeCurve(fn, 24, hot ? 1.1 : 0.7, rgba(c, hot ? 0.72 : 0.32));
      const p = fn(1), q = fn(0.95);
      this.arrow(p[0] + 1, p[1], Math.atan2(p[1] - q[1], p[0] - q[0]), 4.3, rgba(c, hot ? 0.85 : 0.5));
      if (hot || e.a === this.hover || e.b === this.hover) this.flow(fn, rgba(mix(C.text, C[this.edgeColorKey(e)] || C.base, 0.3), 0.75));
    }
    ctx.globalAlpha = A0;
    for (const n of this.nodes) {
      const dim = keep && !keep.has(n.id), opacity = A0 * (dim ? 0.2 : 1);
      ctx.globalAlpha = opacity;
      const fr = P.fresh && P.fresh.get(n.id), age = fr ? Math.max(0, (Date.now() - fr.t) / 1000) : 99;
      if (fr && !this.bursted.has(n.id + fr.t)) {
        this.bursted.add(n.id + fr.t);
        this.burst(n.id, fr.kind === 'new' ? 'claude' : fr.to === 'owner' ? 'you' : fr.to);
      }
      let sc = 1;
      if (fr && fr.kind === 'new' && age < 0.7 && !this.reduce) {
        const t = age / 0.7 - 1; sc = Math.max(0.05, 1 + 2.70158 * t * t * t + 1.70158 * t * t);
      }
      ctx.save();
      if (sc !== 1) { ctx.translate(n.x, n.y); ctx.scale(sc, sc); ctx.translate(-n.x, -n.y); }
      this.drawChip(n, dim); ctx.restore();
      const x0 = n.x - n.w / 2, y0 = n.y - n.h / 2;
      if (fr) {
        const col = fr.kind === 'new' ? C.claude : C[fr.to === 'owner' ? 'you' : fr.to] || C.base;
        const pulse = this.reduce ? 0.65 : 0.5 + 0.5 * Math.sin(time * 3.2);
        rrect(ctx, x0 - 6, y0 - 6, n.w + 12, n.h + 12, (n.h + 12) / 2);
        ctx.strokeStyle = rgba(col, 0.25 + 0.35 * pulse); ctx.lineWidth = 1; ctx.stroke();
        const label = fr.kind === 'new' ? 'NEW' : FRESH_LABEL[fr.to] || 'CHANGED';
        ctx.font = `700 9px ${this.F}`; ctx.letterSpacing = '0.7px';
        const width = ctx.measureText(label).width + 14;
        rrect(ctx, x0 + 7, y0 - 18, width, 14, 7); ctx.fillStyle = rgba(col, 1); ctx.fill();
        ctx.fillStyle = rgba(C.void, 1); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x0 + 14, y0 - 11); ctx.letterSpacing = '0px';
      }
      const runner = P.isRunning(n.it);
      if (runner) {
        const rc = C[runner] || C.claude, label = runner === 'codex' ? 'CODEX RUNNING' : 'CLAUDE WORKING';
        rrect(ctx, x0 - 3, y0 - 3, n.w + 6, n.h + 6, (n.h + 6) / 2);
        ctx.setLineDash([5, 6]); ctx.lineDashOffset = -time * 18;
        ctx.strokeStyle = rgba(rc, 0.95); ctx.lineWidth = 1.2; ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
        const a = time * 3;
        ctx.beginPath(); ctx.arc(x0 + n.w - 11, y0 + 14.5, 3.5, a, a + 4.2);
        ctx.strokeStyle = rgba(rc, 1); ctx.lineWidth = 1.2; ctx.stroke();
        ctx.font = `700 9px ${this.F}`; ctx.letterSpacing = '0.5px';
        const width = ctx.measureText(label).width + 14;
        rrect(ctx, x0 + n.w - width - 7, y0 + n.h + 4, width, 14, 7);
        ctx.fillStyle = rgba(rc, 0.95); ctx.fill();
        ctx.fillStyle = rgba(C.void, 1); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x0 + n.w - width, y0 + n.h + 11); ctx.letterSpacing = '0px';
      }
      if (this.sel === n.id || this.hover === n.id) {
        rrect(ctx, x0 - 4, y0 - 4, n.w + 8, n.h + 8, (n.h + 8) / 2);
        ctx.strokeStyle = rgba(C.text, this.sel === n.id ? 0.7 : 0.3); ctx.lineWidth = 0.9; ctx.stroke();
      }
      if (this.dropId === n.id) {
        ctx.globalAlpha = A0 * 0.25;
        ctx.drawImage(this.stars.glow.claude, x0 - 25, y0 - 23, n.w + 50, n.h + 46);
        ctx.globalAlpha = A0;
        rrect(ctx, x0 - 9, y0 - 9, n.w + 18, n.h + 18, (n.h + 18) / 2);
        ctx.setLineDash([6, 5]); ctx.lineDashOffset = -time * 12;
        ctx.strokeStyle = rgba(C.claude, 1); ctx.lineWidth = 2; ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.globalAlpha = opacity;
      }
      const rp = P.replies && P.replies.get(n.id);
      if (rp && rp.open) {
        // A satellite outside the rounded rim leaves the gate and running mark unobscured.
        const bx = x0 + n.w, by = y0;
        ctx.fillStyle = rgba(C.bg, 1); ctx.beginPath(); ctx.arc(bx, by, 7.5, 0, Math.PI * 2); ctx.fill();
        if (rp.seen) {
          ctx.strokeStyle = rgba(C.claude, 1); ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.arc(bx, by, 6, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(bx - 2.6, by); ctx.lineTo(bx - 0.6, by + 2.2); ctx.lineTo(bx + 2.8, by - 2.2); ctx.stroke();
        } else {
          const pulse = this.reduce ? 0 : (time * 0.8) % 1;
          ctx.strokeStyle = rgba(C.claude, 0.6 * (1 - pulse)); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(bx, by, 6 + pulse * 9, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = rgba(C.claude, 1); ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = rgba(C.void, 1); ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(bx, by + 2.5); ctx.lineTo(bx, by - 2.5);
          ctx.moveTo(bx - 2.2, by - 0.4); ctx.lineTo(bx, by - 2.6); ctx.lineTo(bx + 2.2, by - 0.4); ctx.stroke();
        }
      }
    }
    ctx.restore(); ctx.globalAlpha = A0;
  }
  drawFx(dt) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = this.C.dark ? 'lighter' : 'source-over';
    for (const r of this.rings) {
      r.life += dt;
      if (r.life < 0) continue;
      const p = Math.min(1, r.life / r.max), rad = r.r0 + (r.r1 - r.r0) * ease(p);
      ctx.strokeStyle = rgba(r.c, (r.thin ? 0.45 : 0.9) * (1 - p)); ctx.lineWidth = r.thin ? 1.2 : 2.5 * (1 - p) + 0.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, 6.283); ctx.stroke();
    }
    this.rings = this.rings.filter((r) => r.life < r.max);
    for (const p of this.particles) {
      p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.93; p.vy *= 0.93;
      const a = Math.max(0, 1 - p.life / p.max);
      ctx.fillStyle = rgba(p.c, a); ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (0.5 + a * 0.5), 0, 6.283); ctx.fill();
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* ------------------------------------------------------------------- view */
class BrainView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = 'top';
    this.brainId = null;
    this.sel = null;
    this.draft = { verdict: null, note: '' };
  }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Brain Network'; }
  getIcon() { return 'brain-circuit'; }
  /* Panels, by the names the owner uses: the Galaxy (all brains) or a Roadmap fills the view; the Bar runs along the
     top, the Inbox floats on the left, the Chat is docked full height on the right (Ctrl+Space), and the Card and its
     Moons (one per piece of evidence) float beside the selected node. */
  async onOpen() {
    const root = this.contentEl;
    root.empty(); root.addClass('bn-root'); root.tabIndex = 0;
    this.stageEl = root.createDiv('bn-stage');
    this.stage = new Stage(this.stageEl, this);
    this.overlay = root.createDiv('bn-overlay');
    this.moonLayer = this.overlay.createDiv('bn-moons');
    this.card = this.overlay.createDiv('bn-card'); this.card.hide();
    this.moons = [];
    this.bar = root.createDiv('bn-bar');
    this.inbox = root.createDiv('bn-inbox');
    this.drawer = root.createDiv('bn-dock');
    this.grip = this.drawer.createDiv({ cls: 'bn-grip', attr: { 'aria-label': 'Drag to resize · Ctrl+Space to hide' } });
    this.chatHost = this.drawer.createDiv('bn-dock-chat');
    this.refs = new Refs(this.plugin, () => this.refBrain());
    this.chat = new ChatPanel(this.plugin, this.chatHost, { embedded: true });
    this.addChild(this.chat);
    this.bindGrip(); this.bindDrop();
    this.setDrawer(!!this.plugin.settings.drawerOpen, true);
    this.hint = root.createDiv('bn-hint');
    this.keys = root.createDiv('bn-keys'); this.keys.hide();
    this.lightbox = root.createDiv('bn-lightbox'); this.lightbox.hide();
    this.registerDomEvent(root, 'keydown', (e) => this.onKey(e));
    this.registerEvent(this.app.workspace.on('css-change', () => { this.stage.readColors(); this.plugin.layoutCache.clear(); }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.updateInsets()));
    this.updateInsets();
    this.refresh(true);
  }
  async onClose() { this.stage && this.stage.destroy(); }
  get model() { return this.plugin.model; }
  leftInset() { return this.inboxOpen() ? Math.min(340, this.contentEl.clientWidth * 0.4) + 12 : 0; }
  bottomInset() { return this._bottom || 0; }
  dockPx() { return Math.round(Math.max(320, Math.min(this.plugin.settings.dockW || 440, this.contentEl.clientWidth * 0.62))); }
  /* the brain the node pane and chat are about: the open strand, else the selected or last brain */
  /* the brain the Chat talks to: the roadmap's brain, or the brain selected on the Galaxy. Deselecting keeps the
     Chat where it is; only selecting another brain moves it. */
  refBrain() {
    if (this.mode === 'strand') return this.brainId;
    if (this.sel && this.model && this.model.byBrain.has(this.sel)) return this.sel;
    const cur = this.chat && this.chat.brainId;
    return cur && this.model && this.model.byBrain.has(cur) ? cur : this.plugin.settings.lastBrain;
  }
  /* the Chat dock (the "drawer" in settings and commands, which is what it used to be) */
  setDrawer(open, instant) {
    this.drawerOpen = open;
    this.contentEl.style.setProperty('--bn-dock-w', this.dockPx() + 'px');
    this.drawer.toggleClass('is-open', open); this.drawer.toggleClass('is-instant', !!instant);
    this.contentEl.toggleClass('has-dock', open);
    if (open) { this.syncChat(); setTimeout(() => this.chat.scrollEnd(), 340); }
    if (this.model && this.stage && this.stage.byId) this.renderBar();
    if (this.plugin.settings.drawerOpen !== open) { this.plugin.settings.drawerOpen = open; this.plugin.saveSettings(); }
    if (!instant && this.stage) {
      if (this.sel && this.stage.byId && this.stage.byId.has(this.sel)) this.centerOn(this.sel);
      else if (!this.stage.userMoved) this.stage.tween(this.stage.fitCam(), 320);
    }
  }
  toggleDrawer(focusChat) {
    this.setDrawer(!this.drawerOpen);
    if (this.drawerOpen && focusChat !== false) setTimeout(() => this.chat.input && this.chat.input.focus(), 320);
    if (!this.drawerOpen) this.contentEl.focus({ preventScroll: true });
  }
  bindGrip() {
    let drag = null;
    this.grip.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, w: this.dockPx() }; this.grip.setPointerCapture(e.pointerId); this.drawer.addClass('is-instant'); });
    this.grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.plugin.settings.dockW = Math.round(Math.max(320, Math.min(this.contentEl.clientWidth * 0.62, drag.w + drag.x - e.clientX)));
      this.contentEl.style.setProperty('--bn-dock-w', this.dockPx() + 'px');
    });
    this.grip.addEventListener('pointerup', () => { if (!drag) return; drag = null; this.plugin.saveSettings(); this.drawer.removeClass('is-instant'); });
    this.grip.addEventListener('dblclick', () => this.toggleDrawer(false));
  }
  /* Files and images dropped anywhere on the map become attachments in the Chat; dropped on a node, the message is about
     that node. Works for files from the system and from Obsidian's file explorer. */
  bindDrop() {
    const root = this.contentEl;
    let depth = 0;
    const has = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files') || !!(this.app.dragManager && this.app.dragManager.draggable && (this.app.dragManager.draggable.file || this.app.dragManager.draggable.files));
    const end = () => { depth = 0; root.removeClass('is-dropping'); this.stage.dropId = null; };
    root.addEventListener('dragenter', (e) => { if (!has(e)) return; e.preventDefault(); e.stopPropagation(); depth++; root.addClass('is-dropping'); });
    root.addEventListener('dragover', (e) => {
      if (!has(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const r = this.stage.canvas.getBoundingClientRect(), onCanvas = e.target === this.stage.canvas || this.overlay.contains(e.target);
      const n = onCanvas ? this.stage.hit(e.clientX - r.left, e.clientY - r.top) : null;
      this.stage.dropId = n ? n.id : null;
    });
    root.addEventListener('dragleave', (e) => { if (!has(e)) return; if (--depth <= 0) end(); });
    root.addEventListener('drop', (e) => {
      if (!has(e)) return;
      e.preventDefault(); e.stopPropagation();
      const id = this.stage.dropId;
      end();
      this.onDrop(e, id).catch((x) => { console.error(x); new Notice('Could not attach: ' + x.message); });
    });
  }
  async onDrop(e, id) {
    const C = this.chat, dm = this.app.dragManager && this.app.dragManager.draggable, out = [];
    if (dm && dm.file && dm.file.extension) out.push(C.attachVault(dm.file));
    else if (dm && dm.files) dm.files.forEach((f) => f.extension && out.push(C.attachVault(f)));
    for (const f of (e.dataTransfer && e.dataTransfer.files) || []) {
      let p = '';
      try { p = require('electron').webUtils.getPathForFile(f); } catch (x) { p = f.path || ''; }
      out.push(p ? C.attachPath(p) : await C.saveBlob(f));
    }
    if (!out.length) return;
    if (id && id !== this.sel) this.select(id);
    if (!this.drawerOpen) this.setDrawer(true);
    this.syncChat();
    C.addAttachments(out);
    setTimeout(() => C.input && C.input.focus(), 360);
  }
  /* the chat follows the brain on screen; in a strand, the selected node is what the next message is about */
  syncChat() {
    if (!this.chat || !this.model) return;
    const bid = this.refBrain();
    if (!bid) return;
    this.chat.setBrain(bid, this.mode === 'strand' && this.sel && this.model.byItem.has(this.sel) ? this.sel : null, false);
  }
  /* Obsidian's status bar floats over the bottom-right of the workspace; keep our panels and hints above it */
  updateInsets() {
    const sb = document.querySelector('.app-container .status-bar') || document.querySelector('.status-bar');
    const r = this.contentEl.getBoundingClientRect();
    let b = 0;
    if (sb && sb.offsetParent !== null) {
      const q = sb.getBoundingClientRect();
      if (q.height && q.top < r.bottom && q.bottom > r.top && q.right > r.left && q.left < r.right) b = Math.ceil(r.bottom - q.top);
    }
    if (b !== this._bottom) { this._bottom = b; this.contentEl.style.setProperty('--bn-bottom', b + 'px'); }
  }
  rightInset() { return this.drawerOpen ? this.dockPx() : 0; }
  inboxOpen() { return !!this.plugin.settings.inboxOpen && this.contentEl.clientWidth > 640; }

  /* rebuild from the model; keep positions stable unless the set of nodes changed */
  refresh(fit) {
    const m = this.model;
    if (!m) return;
    if (this.mode === 'strand') {
      const b = m.byBrain.get(this.brainId);
      if (!b) { this.mode = 'top'; return this.refresh(true); }
      const lay = this.plugin.strandLayout(b);
      this.stage.mode = 'strand';
      this.stage.setStrand(m, b, lay);
    } else {
      this.stage.mode = 'top';
      this.stage.setTop(m, this.plugin.topLayout());
    }
    if (this.sel && !this.stage.byId.has(this.sel)) this.sel = null;
    this.stage.sel = this.sel;
    if (fit) { this.stage.needFit = true; this.stage.userMoved = false; }
    this.renderBar(); this.renderInbox(); this.renderHint();
    this.renderPanel(); this.syncChat();
  }
  renderHint() {
    const h = this.hint; h.empty();
    h.style.left = (this.leftInset() + 14) + 'px';
    const key = (k, t) => { const s = h.createSpan('bn-hk'); s.createEl('kbd', { text: k }); s.createSpan({ text: t }); };
    if (this.mode === 'top') { key('Dbl-click', 'open a roadmap'); if (this.plugin.settings.lastBrain) key('Tab', 'last brain'); }
    else { key('Tab', 'Galaxy'); key('J K', 'next / previous for you'); }
    key('Ctrl Space', 'Chat');
    key('?', 'keys and panels');
    this.renderKeys();
  }
  renderKeys() {
    const k = this.keys; k.empty();
    k.style.left = (this.leftInset() + 14) + 'px';
    k.createDiv({ cls: 'bn-eyebrow', text: 'Keys' });
    const rows = [
      ['Tab', 'Switch between the Galaxy and the last Roadmap you opened'],
      ['J / K', 'Next / previous item waiting on you, across brains'],
      ['Enter', "Open the selected brain's Roadmap, or the selected item's note"],
      ['I', 'Show or hide the Inbox'],
      ['Ctrl + Space', 'Show or hide the Chat'],
      ['S', "Open the Chat and type to this brain's Claude session"],
      ['F', 'Fit everything in view'],
      ['Esc', 'Close, deselect, then go back to the Galaxy'],
    ];
    const t = k.createDiv('bn-keytable');
    rows.forEach(([a, b]) => { t.createEl('kbd', { text: a }); t.createSpan({ text: b }); });
    k.createDiv({ cls: 'bn-eyebrow', text: 'Panels' });
    const names = [
      ['Galaxy', 'All brains, as star systems'], ['Roadmap', "One brain's items, by lane and date"], ['Bar', 'Along the top'],
      ['Inbox', 'Left: what waits on you'], ['Chat', "Right: the brain's Claude session"], ['Card', 'Beside the selected node'],
      ['Moons', "Bubbles around it: the node's images, files and linked notes"],
    ];
    const n = k.createDiv('bn-keytable is-names');
    names.forEach(([a, b]) => { n.createSpan({ cls: 'bn-pname', text: a }); n.createSpan({ text: b }); });
    k.createDiv({ cls: 'bn-muted', text: 'Drop files or images anywhere to attach them to the Chat, or on a node to attach them there.' });
  }
  renderBar() {
    const bar = this.bar; bar.empty();
    const crumb = bar.createDiv('bn-crumb');
    if (this.mode === 'top') crumb.createSpan({ text: 'Galaxy', cls: 'bn-crumb-cur', attr: { 'aria-label': 'All brains' } });
    else {
      const back = crumb.createEl('button', { text: 'Galaxy', cls: 'bn-crumb-link', attr: { 'aria-label': 'Back to all brains (Tab)' } });
      back.onclick = () => this.exitStrand();
      crumb.createSpan({ text: '›', cls: 'bn-crumb-sep' });
      crumb.createSpan({ text: this.model.byBrain.get(this.brainId).name, cls: 'bn-crumb-cur' });
    }
    const pills = bar.createDiv('bn-pills');
    const items = this.mode === 'top' ? this.model.items : this.model.byBrain.get(this.brainId).items;
    const c = countStates(items);
    for (const k of STATE_ORDER) {
      if (!c[k]) continue;
      const p = pills.createEl('button', { cls: 'bn-pill' + (this.stage.filter === k ? ' is-on' : '') + (this.mode === 'top' ? ' is-static' : '') });
      p.createSpan({ cls: 'bn-dot bn-' + k });
      p.createSpan({ text: `${STATE[k].short} ${c[k]}` });
      if (this.mode === 'strand') p.onclick = () => { this.stage.filter = this.stage.filter === k ? null : k; this.select(null); this.renderBar(); };
    }
    bar.createDiv('bn-spacer');
    const ib = bar.createEl('button', { cls: 'bn-btn' + (this.inboxOpen() ? ' is-on' : ''), attr: { 'aria-label': 'Inbox: what waits on you (I)' } });
    setIcon(ib.createSpan(), 'inbox');
    ib.createSpan({ text: `Inbox · ${this.model.items.filter((i) => i.state === 'owner').length}` });
    ib.onclick = () => this.toggleInbox();
    const bid = this.refBrain(), running = bid && this.plugin.runningIn(bid);
    const cb = bar.createEl('button', { cls: 'bn-btn bn-claude-btn' + (running ? ' is-running' : '') + (this.drawerOpen ? ' is-on' : ''), attr: { 'aria-label': 'Chat with this brain\'s Claude session (Ctrl+Space)' } });
    setIcon(cb.createSpan(), running ? 'loader' : 'message-circle');
    cb.createSpan({ text: running ? 'Claude is working' : 'Chat' });
    cb.onclick = () => this.toggleDrawer();
    if (this.mode === 'top' && Object.keys(this.plugin.settings.pins.top || {}).length) {
      const reset = bar.createEl('button', { cls: 'bn-btn bn-icon', attr: { 'aria-label': 'Put the brains back where the layout wants them' } });
      setIcon(reset, 'rotate-ccw');
      reset.onclick = () => { this.plugin.resetPins(null); this.refresh(false); this.renderBar(); this.stage.tween(this.stage.fitCam(), 400); };
    }
  }

  /* ---------- inbox: everything waiting on you, across brains ---------- */
  renderInbox() {
    const box = this.inbox; box.empty();
    if (!this.inboxOpen()) { box.hide(); return; }
    box.show();
    const mine = this.waitingOrder();
    box.createDiv({ cls: 'bn-eyebrow', text: 'Inbox' });
    const head = box.createDiv('bn-inbox-head');
    head.createEl('h3', { text: 'Waiting on you' });
    head.createSpan({ text: String(mine.length), cls: 'bn-count' });
    if (!mine.length) box.createEl('p', { text: 'Nothing is waiting on you.', cls: 'bn-muted' });
    const groups = new Map();
    mine.forEach((i) => { if (!groups.has(i.brain)) groups.set(i.brain, []); groups.get(i.brain).push(i); });
    for (const [bid, its] of groups) {
      box.createDiv({ text: this.model.byBrain.get(bid).name, cls: 'bn-group' });
      for (const it of its) {
        const row = box.createDiv('bn-row' + (this.sel === it.id ? ' is-sel' : ''));
        const th = row.createDiv('bn-thumb');
        this.plugin.media(it).then((m) => { const img = m.find((x) => x.kind === 'img' && x.exists); if (img) th.createEl('img', { attr: { src: img.src, loading: 'lazy', alt: '' } }); else setIcon(th, it.gate === 'art' ? 'image' : 'help-circle'); });
        const tx = row.createDiv('bn-row-text');
        tx.createDiv({ text: it.title, cls: 'bn-row-title' });
        tx.createDiv({ text: (GATE[it.gate] || 'Your call') + (it.ask ? ' · ' + it.ask : ''), cls: 'bn-row-sub' });
        row.onclick = () => this.focusItem(it.id);
      }
    }
    const sent = this.model.items.filter((i) => { const r = this.plugin.replies.get(i.id); return r && r.open; });
    if (sent.length) {
      box.createDiv({ text: 'Your replies, with Claude', cls: 'bn-group' });
      for (const it of sent) {
        const r = this.plugin.replies.get(it.id), row = box.createDiv('bn-sent' + (this.sel === it.id ? ' is-sel' : ''));
        row.createSpan({ cls: 'bn-sent-ic ' + (r.seen ? 'is-seen' : 'is-wait') });
        const tx = row.createDiv('bn-row-text');
        tx.createDiv({ text: it.title, cls: 'bn-row-title' });
        tx.createDiv({ cls: 'bn-row-sub', text: r.seen ? `Read by Claude ${ago(r.seen.at)}` : `Sent ${ago(r.t)} · not read yet` });
        row.onclick = () => this.focusItem(it.id);
      }
    }
    const theirs = this.model.items.filter((i) => i.state === 'claude');
    if (theirs.length) {
      const d = box.createEl('details', { cls: 'bn-claudeq' });
      d.createEl('summary', { text: `Waiting on Claude · ${theirs.length}` });
      const cp = d.createEl('button', { text: "Copy Claude's queue as a prompt", cls: 'bn-btn bn-small' });
      cp.onclick = () => this.plugin.copy(this.plugin.queuePrompt(theirs), 'Prompt copied. Paste it into a Claude session.');
      for (const it of theirs) {
        const r = d.createDiv({ cls: 'bn-mini' });
        r.createSpan({ cls: 'bn-dot bn-claude' });
        r.createSpan({ text: it.title });
        r.onclick = () => this.focusItem(it.id);
      }
    }
  }

  /* ---------- selection & navigation ---------- */
  select(id) {
    if (id !== this.sel) this.draft = { verdict: null, note: '' };
    this.sel = id; this.stage.sel = id;
    if (id && this.plugin.fresh && this.plugin.fresh.delete(id)) this.renderBar();
    if (id && !this.drawerOpen && this.plugin.settings.chatOnSelect) this.setDrawer(true);
    this.renderPanel(); this.syncChat();
    this.renderInbox();
  }
  onClick(id) { this.stage.filter = null; this.select(id); }
  /* inbox order: brains in model order, each brain's waiting items by date */
  waitingOrder() {
    const mine = this.model.items.filter((i) => i.state === 'owner'), out = [];
    for (const b of this.model.brains) out.push(...mine.filter((i) => i.brain === b.id).sort((a, c) => (a.date || '9').localeCompare(c.date || '9')));
    return out;
  }
  stepWaiting(d) {
    const list = this.waitingOrder();
    if (!list.length) { new Notice('Nothing is waiting on you.'); return; }
    const i = list.findIndex((x) => x.id === this.sel);
    this.focusItem(list[i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length].id);
  }
  toggleLast() {
    if (this.mode === 'strand') { this.exitStrand(); return; }
    const id = this.plugin.settings.lastBrain, b = id && this.model.byBrain.get(id);
    if (b && b.items.length) this.enterStrand(id);
    else new Notice('Open a brain first. Tab then switches between it and all brains.');
  }
  toggleInbox() {
    this.plugin.settings.inboxOpen = !this.plugin.settings.inboxOpen; this.plugin.saveSettings();
    this.renderBar(); this.renderInbox(); this.renderHint();
    if (!this.stage.userMoved) this.stage.tween(this.stage.fitCam(), 350);
  }
  onVoid() { this.select(null); }
  onDouble(id) { if (this.mode === 'top' && this.model.byBrain.get(id).items.length) this.enterStrand(id); }
  onPin(id, n) { this.plugin.setPin(this.mode === 'top' ? null : this.brainId, id, n.x, n.y); }
  focusItem(id) {
    const it = this.model.byItem.get(id);
    if (!it) return;
    if (this.mode === 'strand' && this.brainId === it.brain) { this.select(id); this.centerOn(id); return; }
    this.enterStrand(it.brain, id);
  }
  centerOn(id) {
    const n = this.stage.byId.get(id);
    if (!n) return;
    /* a little above the middle, so the Card has room below and the Moons above */
    const k = Math.max(this.stage.cam.k, 0.9), left = this.leftInset(), right = this.rightInset(), top = 56, bottom = this.bottomInset();
    this.stage.tween({ k, x: left + (this.stage.W - left - right) / 2 - n.x * k, y: top + (this.stage.H - top - bottom) * 0.4 - n.y * k }, 450);
  }
  enterStrand(brainId, focus) {
    const b = this.model.byBrain.get(brainId);
    if (!b) return;
    const go = () => {
      this.mode = 'strand'; this.brainId = brainId; this.sel = focus || null; this.stage.filter = null;
      if (this.plugin.settings.lastBrain !== brainId) { this.plugin.settings.lastBrain = brainId; this.plugin.saveSettings(); }
      this.stage.userMoved = false;
      this.refresh(false);
      const to = this.stage.fitCam();
      this.stage.cam = { k: to.k * 0.82, x: to.x + this.stage.W * 0.09, y: to.y + this.stage.H * 0.09 };
      this.stage.alpha = 0;
      if (focus && !this.drawerOpen && this.plugin.settings.chatOnSelect) this.setDrawer(true, true);
      this.stage.tween(to, 480, 1, () => focus && this.centerOn(focus));
    };
    if (this.mode === 'top') {
      const n = this.stage.byId.get(brainId);
      this.stage.burst(brainId, 'base', 'in');
      this.topCam = { ...this.stage.cam };
      const k = this.stage.cam.k * 2.6;
      this.stage.tween({ k, x: this.stage.W / 2 - n.x * k, y: this.stage.H / 2 - n.y * k }, 380, 0, go);
    } else go();
  }
  exitStrand() {
    if (this.mode !== 'strand') return;
    const from = this.brainId;
    this.stage.tween({ k: this.stage.cam.k * 0.6, x: this.stage.cam.x * 0.6 + this.stage.W * 0.2, y: this.stage.cam.y * 0.6 + this.stage.H * 0.2 }, 300, 0, () => {
      this.mode = 'top'; this.sel = null; this.stage.filter = null;
      this.refresh(false);
      const back = this.topCam || this.stage.fitCam(), n = this.stage.byId.get(from);
      if (n) { const k = back.k * 2.6; this.stage.cam = { k, x: this.stage.W / 2 - n.x * k, y: this.stage.H / 2 - n.y * k }; }
      this.stage.alpha = 0;
      this.stage.tween(back, 420, 1);
    });
  }
  onKey(e) {
    if (e.target && /TEXTAREA|INPUT|SELECT/.test(e.target.tagName)) return;
    if (this.lightbox.isShown()) {
      if (e.key === 'Escape') this.closeLightbox();
      if (e.key === 'ArrowRight') this.lbStep(1);
      if (e.key === 'ArrowLeft') this.lbStep(-1);
      e.preventDefault(); return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'Escape') { if (this.keys.isShown()) this.keys.hide(); else if (this.sel) this.select(null); else if (this.drawerOpen) this.setDrawer(false); else if (this.mode === 'strand') this.exitStrand(); }
    else if (k === 'Tab') this.toggleLast();
    else if (k === 'j') this.stepWaiting(1);
    else if (k === 'k') this.stepWaiting(-1);
    else if (k === 'i') this.toggleInbox();
    else if (k === 's') this.chatAbout();
    else if (k === 'f') { this.stage.userMoved = false; this.stage.tween(this.stage.fitCam(), 400); }
    else if (k === '?' || k === '/') this.keys.isShown() ? this.keys.hide() : this.keys.show();
    else if (k === 'Enter' && this.sel) {
      if (this.mode === 'top') { if (this.model.byBrain.get(this.sel).items.length) this.enterStrand(this.sel); }
      else { const it = this.model.byItem.get(this.sel); if (it) this.plugin.openNote(it.plan ? (it.link ? linkTarget(it.link) : it.file) : it.file, !it.plan && 'Result'); }
    } else return;
    e.preventDefault();
  }

  /* ---------- the Card: what this node is, what to check, and the one-click calls; the Moons: its evidence ---------- */
  liveChanged() { this.renderInbox(); this.renderBar(); this.renderPanel(); }
  renderPanel() {
    if (!this.card || !this.model) return;
    const a = document.activeElement;
    if (a && this.card.contains(a) && a.tagName === 'SELECT') return;
    const it = this.mode === 'strand' && this.sel ? this.model.byItem.get(this.sel) : null;
    const b = !it && this.mode === 'top' && this.sel ? this.model.byBrain.get(this.sel) : null;
    const c = this.card, key = this.mode + '|' + (this.sel || '');
    const keepScroll = this._cardFor === key ? c.scrollTop : 0, fresh = this._cardFor !== key;
    this._cardFor = key;
    if (fresh) this.loadMoons(it);
    c.empty();
    if (!it && !b) { c.hide(); this._cardSize = null; return; }
    c.show();
    if (fresh) { c.removeClass('is-in'); void c.offsetWidth; c.addClass('is-in'); }
    const close = c.createEl('button', { cls: 'bn-close', attr: { 'aria-label': 'Deselect (Esc)' } });
    setIcon(close, 'x');
    close.onclick = () => this.select(null);
    if (it) this.itemCard(c, it); else this.brainCard(c, b);
    this._cardSize = { w: c.offsetWidth, h: c.scrollHeight + 2 };
    c.scrollTop = keepScroll;
  }
  sec(p, label) { const s = p.createDiv('bn-sec'); if (label) s.createDiv({ text: label, cls: 'bn-label' }); return s; }
  brainCard(p, b) {
    p.createDiv({ cls: 'bn-eyebrow', text: b.kind === 'folder' ? 'Card · folder' : 'Card · brain' });
    p.createEl('h2', { text: b.name });
    const c = b.counts, row = p.createDiv('bn-counts');
    for (const k of STATE_ORDER) if (c[k]) { const x = row.createDiv('bn-cnt'); x.createSpan({ cls: 'bn-dot bn-' + k }); x.createSpan({ text: `${c[k]} ${STATE[k].label.toLowerCase()}` }); }
    for (const x of (this.model.broken || []).filter((y) => y.brain === b.id)) {
      const w = p.createDiv('bn-broken');
      setIcon(w.createSpan(), 'alert-triangle');
      w.createSpan({ text: 'The front matter of ' });
      const a = w.createEl('a', { text: x.path.split('/').pop().replace(/\.md$/, ''), href: '#' });
      a.onclick = (e) => { e.preventDefault(); this.app.workspace.openLinkText(x.path, '', 'tab'); };
      w.createSpan({ text: " doesn't parse (often a repeated key, or a colon in an unquoted value), so the map ignores any brain fields in it." });
    }
    if (!b.items.length) p.createDiv({ cls: 'bn-muted', text: 'No tracked items yet. A note in this folder joins the map when it gets a brain-state property, or the front page a brain-plan list.' });
    const lv = this.plugin.live.brains.get(b.id);
    if (lv) p.createDiv({ cls: 'bn-live', text: `Claude edited ${lv.files.size} file${lv.files.size === 1 ? '' : 's'} here ${ago(lv.last)}` });
    const mine = b.items.filter((i) => i.state === 'owner');
    if (mine.length) {
      const s = this.sec(p, 'Waiting on you');
      for (const it of mine.slice(0, 5)) { const r = s.createDiv('bn-mini'); r.createSpan({ cls: 'bn-dot bn-owner' }); r.createSpan({ text: it.title }); r.onclick = () => this.focusItem(it.id); }
      if (mine.length > 5) s.createDiv({ cls: 'bn-muted', text: `${mine.length - 5} more in the Inbox` });
    }
    if (b.tasks) {
      const s = this.sec(p, `Front-page checklist · ${b.tasks}`);
      this.plugin.tasks(b).then((ts) => { ts.slice(0, 4).forEach((t) => s.createDiv({ cls: 'bn-task', text: t })); this._cardSize = { w: p.offsetWidth, h: p.scrollHeight + 2 }; });
    }
    const rel = this.sec(p, 'Linked brains'), chips = rel.createDiv('bn-rel');
    b.parents.forEach((pid) => {
      const pb = this.model.byBrain.get(pid), ch = chips.createDiv('bn-relchip');
      ch.createSpan({ cls: 'bn-relchip-dir', text: '↑' });
      ch.createSpan({ text: pb.name }).onclick = () => this.select(pid);
      const x = ch.createEl('button', { cls: 'bn-x', attr: { 'aria-label': 'Remove this parent' } }); setIcon(x, 'x');
      x.onclick = () => this.plugin.setParent(b, pb, false);
    });
    b.children.forEach((cid) => { const x = chips.createDiv('bn-relchip'); x.createSpan({ cls: 'bn-relchip-dir', text: '↓' }); x.createSpan({ text: this.model.byBrain.get(cid).name }).onclick = () => this.select(cid); });
    const options = this.model.brains.filter((o) => o.id !== b.id && !b.parents.includes(o.id));
    if (options.length) {
      const sel = rel.createEl('select', { cls: 'dropdown bn-addparent' });
      sel.createEl('option', { text: '+ Link a parent brain…', value: '' });
      options.forEach((o) => sel.createEl('option', { text: o.name, value: o.id }));
      sel.onchange = () => sel.value && this.plugin.setParent(b, this.model.byBrain.get(sel.value), true);
    }
    const acts = p.createDiv('bn-actions');
    if (b.items.length) { const o = acts.createEl('button', { text: 'Open roadmap', cls: 'mod-cta' }); o.onclick = () => this.enterStrand(b.id); }
    const f = acts.createEl('button', { text: 'Front page' }); f.onclick = () => this.plugin.openNote(b.file);
    const ch = acts.createEl('button', { text: 'Chat' }); ch.onclick = () => this.chatAbout();
  }
  /* what the current step of a node means, in one line */
  stepText(it) {
    const codexOn = this.plugin.codexLive && this.plugin.codexLive.has(it.id);
    const g = (GATE[it.gate] || 'call').toLowerCase();
    switch (it.state) {
      case 'owner': return it.gate === 'decision' ? 'A decision only you can make.' : it.gate === 'art' ? 'Codex made it and Claude checked it. The art call is yours.' : it.gate === 'look' ? 'Ready for your look check.' : it.gate === 'approval' ? 'Waiting for your approval.' : 'Your call.';
      case 'claude': return 'Claude verifies the result against the brief' + (it.gate ? `, then your ${g}.` : '.');
      case 'codex': return codexOn ? 'Codex is running this brief now.' : 'The brief is ready. Start Codex hands it to Claude, which runs Codex and then checks the result.';
      case 'planned': return it.plan ? 'Planned. Next: Claude drafts a brief.' : 'Planned.';
      case 'parked': return 'Set aside. Bring it back when it matters again.';
      default: return 'Finished.';
    }
  }
  itemCard(p, it) {
    const P = this.plugin, runner = P.isRunning(it);
    const st = p.createDiv({ cls: 'bn-state is-' + it.state + (runner ? ' is-running' : '') });
    st.createSpan({ cls: 'bn-state-dot' });
    st.createSpan({ text: runner ? (runner === 'codex' ? 'Codex running' : 'Claude working') : it.state === 'owner' ? `${GATE[it.gate] || 'Your call'} · waiting on you` : STATE[it.state].label + (it.gate && !['done', 'parked'].includes(it.state) ? ` · then your ${(GATE[it.gate] || it.gate).toLowerCase()}` : '') });
    p.createEl('h2', { text: it.title });
    p.createDiv({ cls: 'bn-meta', text: [this.model.byBrain.get(it.brain).name, it.stream, it.date].filter(Boolean).join(' · ') });
    p.createDiv({ cls: 'bn-steptext', text: this.stepText(it) });
    if (it.ask) { const s = this.sec(p, it.state === 'owner' ? 'Check' : 'Note'); s.createEl('p', { text: it.ask, cls: it.state === 'owner' ? 'bn-ask' : '' }); }
    const chain = p.createDiv('bn-chain');
    chainFor(it).forEach((c) => { const x = chain.createDiv('bn-link ' + c[1]); x.createSpan({ cls: 'bn-link-dot' }); x.createSpan({ text: c[0] }); });
    const rel = (ids, label) => {
      if (!ids.length) return;
      const s = p.createDiv('bn-relrow');
      s.createSpan({ cls: 'bn-label', text: label });
      ids.forEach((id) => { const o = this.model.byItem.get(id); const x = s.createDiv('bn-relchip'); x.createSpan({ cls: 'bn-dot bn-' + o.state }); x.createSpan({ text: o.title }).onclick = () => { this.select(id); this.centerOn(id); }; });
    };
    rel(it.after, 'From'); rel(it.next, 'Leads to');
    this.trail(p, it);
    const run = P.runs.find((r) => r.item === it.id && (r.status === 'running' || r.status === 'queued'));
    if (run) {
      const r = p.createDiv('bn-runline');
      r.createSpan({ cls: 'bnc-spin' });
      const last = run.steps.filter((s) => s.k === 'tool').slice(-1)[0];
      r.createSpan({ text: run.status === 'queued' ? 'Queued in the Chat' : last ? `${last.name} ${last.text}` : 'Starting…' });
      const stop = r.createEl('button', { cls: 'bn-linkbtn', text: run.status === 'queued' ? 'Cancel' : 'Stop' }); stop.onclick = () => P.stopRun(run);
    }
    const last = P.lastAction && P.lastAction.item === it.id ? P.lastAction : null;
    const acts = p.createDiv('bn-actions');
    if (last) {
      acts.createSpan({ cls: 'bn-done-line', text: `${last.label} · saved under Owner review` });
      const u = acts.createEl('button', { text: 'Undo' }); u.onclick = () => P.undo();
    } else {
      const call = async (verdict, label) => {
        [...acts.querySelectorAll('button')].forEach((x) => { x.disabled = true; });
        try { await P.reply(it, verdict, '', label); } catch (e) { console.error(e); new Notice('Brain Network could not write the reply: ' + e.message); }
      };
      if (it.state === 'owner') {
        const ap = acts.createEl('button', { text: it.gate === 'decision' ? 'Accept' : 'Approve', cls: 'mod-cta', attr: { 'aria-label': it.gate === 'decision' ? 'Accept what is proposed; Claude records it and carries it out' : 'Finished; nothing for Claude to do' } });
        ap.onclick = () => call('approve', it.gate === 'decision' ? 'Accept' : 'Approve');
      }
      if (it.state === 'codex' && !it.plan && !runner && !run) {
        const go = acts.createEl('button', { text: 'Start Codex', cls: 'mod-cta', attr: { 'aria-label': 'Claude starts Codex on this brief, as the brain’s collaboration rules describe' } });
        go.onclick = () => {
          go.disabled = true;
          P.dispatch({ brain: it.brain, item: it.id, file: it.file, title: it.title, text: 'Start Codex on this brief now, the way this brain\'s collaboration rules say. Launch it detached so it keeps running after this reply ends, and make sure the brief\'s brain-state becomes claude when Codex finishes, so your verification shows on the map. Tell me which model you chose and why, and how I can check on the run.' });
          if (!this.drawerOpen) this.setDrawer(true);
        };
      }
      const rp = acts.createEl('button', { text: it.state === 'owner' ? 'Reply' : 'Message', attr: { 'aria-label': it.state === 'owner' ? 'Write your reply in the Chat; it is saved under Owner review' : 'Write to Claude about this node in the Chat' } });
      rp.onclick = () => this.chatAbout();
      if (it.state === 'parked') { const x = acts.createEl('button', { text: 'Bring back' }); x.onclick = () => call('revive', 'Bring back'); }
      else if (it.state !== 'done') { const x = acts.createEl('button', { text: 'Park', attr: { 'aria-label': 'Set it aside; nothing for Claude to do' } }); x.onclick = () => call('park', 'Park'); }
    }
    const tools = acts.createDiv('bn-tools');
    const ic = (icon, label, fn) => { const x = tools.createEl('button', { cls: 'bn-iconbtn', attr: { 'aria-label': label } }); setIcon(x, icon); x.onclick = fn; };
    ic('file-text', 'Open the note', () => P.openNote(it.plan ? (it.link ? linkTarget(it.link) : it.file) : it.file, !it.plan && 'Result'));
    const pr = P.promptFor(it);
    if (pr) ic('clipboard-copy', `Copy a prompt for ${it.state === 'codex' ? 'Codex' : 'Claude'}`, () => P.copy(pr, 'Prompt copied.'));
    ic('link', 'Copy the note path', () => P.copy(it.file, 'Path copied.'));
    const ev = this.evidence && this.evidence.id === it.id ? this.evidence : null;
    if (ev && ev.replies.length) {
      const s = this.sec(p, 'Your replies');
      ev.replies.slice(-3).forEach((l) => s.createDiv({ cls: 'bn-history', text: l }));
    }
    if (ev) {
      const n = this.moons.length;
      const foot = p.createDiv({ cls: 'bn-moonsum', text: n ? `${n} moon${n === 1 ? '' : 's'}: ${ev.summary}` : ev.none || 'The note links no files.' });
      if (this.moons.length > MOONS_MAX) {
        const all = foot.createEl('button', { cls: 'bn-linkbtn', text: this.allMoons ? 'Hide list' : 'List all' });
        all.onclick = () => { this.allMoons = !this.allMoons; this.renderPanel(); };
        if (this.allMoons) { const l = p.createDiv('bn-files'); this.moons.forEach((m) => this.fileRow(l, m)); }
      }
    }
    if (it.status) p.createDiv({ cls: 'bn-status-line', text: it.status });
  }
  /* where your last reply is: sent, read by a Claude session, acted on */
  trail(p, it) {
    const r = this.plugin.replies.get(it.id);
    if (!r) return;
    const words = { reply: 'You replied', approve: 'You approved', back: 'You sent it back', park: 'You parked it', revive: 'You brought it back', note: 'Your note' };
    const t = p.createDiv('bn-trail');
    t.createSpan({ cls: 'bn-trail-dot ' + (r.seen || !r.open ? 'ok' : 'cur') });
    const run = r.run;
    t.createSpan({ text: `${words[r.verdict] || r.verdict} ${ago(r.t)}` + (run ? (run.status === 'done' ? ' · Claude answered in the Chat' : run.status === 'failed' || run.status === 'stopped' ? ` · the Claude run ${run.status}` : ` · ${run.status} in the Chat`)
      : ['reply', 'back', 'note'].includes(r.verdict) ? (r.seen ? ` · read by Claude ${ago(r.seen.at)}` : ' · not read yet') : '') });
    if (r.open && !r.seen && !run) { const c = t.createEl('button', { cls: 'bn-linkbtn', text: 'Copy prompt' }); c.onclick = () => this.plugin.copy(this.plugin.replyPrompt(it), 'Prompt copied. Paste it into a Claude session.'); }
  }
  /* open the Chat about the selected node, cursor in the message box */
  chatAbout() {
    if (!this.drawerOpen) this.setDrawer(true);
    this.syncChat();
    setTimeout(() => this.chat.input && this.chat.input.focus(), 340);
  }
  /* Everything the node's note points at, read from the note when it is selected: files on disk and in the vault,
     linked notes, notes linking here, and your earlier replies. */
  async gatherEvidence(it) {
    const out = { id: it.id, files: [], notes: [], back: [], replies: [], none: null };
    const mc = this.app.metadataCache;
    const f = it.plan ? (it.link ? mc.getFirstLinkpathDest(linkTarget(it.link), it.file) : null) : this.app.vault.getAbstractFileByPath(it.file);
    if (!f) { out.none = it.plan ? 'A plan entry without a note of its own yet.' : 'Note not found.'; return out; }
    const text = await this.app.vault.cachedRead(f);
    const pathish = (t) => /[\/\\]/.test(t) || /\.[A-Za-z][A-Za-z0-9]{1,5}(:\d+)?$/.test(t);
    const raw = [];
    for (const m of text.matchAll(/`([^`\n]{3,300})`/g)) if (pathish(m[1])) raw.push(m[1]);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) raw.push(m[1]);
    for (const m of text.matchAll(/(?:^|[\s(])((?:file:\/\/\/)?[A-Za-z]:[\\/][^\s`'"()<>|*?]+)/gm)) raw.push(m[1]);
    const seen = new Set([f.path]), ctx = { dirs: [] };
    for (const r0 of raw) {
      if (/^(https?|mailto):/i.test(r0)) continue;
      const r = this.refs.resolveRef(r0, ctx);
      if (!r) continue;
      if (r.external) { const q = r.external.replace(/\/+$/, '').split('/'); ctx.dirs = [q.slice(0, -1).join('/'), ...ctx.dirs].slice(0, 8); }
      const key = r.missing || r.external || (r.file && r.file.path) || (r.folder && r.folder.path);
      if (seen.has(key)) continue;
      seen.add(key);
      (r.file && r.file.extension === 'md' ? out.notes : out.files).push(r);
    }
    const cache = mc.getFileCache(f) || {};
    for (const l of [...(cache.links || []), ...(cache.embeds || [])]) {
      const d = mc.getFirstLinkpathDest(linkTarget(l.link), f.path);
      if (!d || seen.has(d.path)) continue;
      seen.add(d.path);
      (d.extension === 'md' ? out.notes : out.files).push({ file: d });
    }
    out.back = Object.entries(mc.resolvedLinks || {}).filter(([src, to]) => to[f.path] && src !== f.path && !seen.has(src)).map(([src]) => this.app.vault.getAbstractFileByPath(src)).filter(Boolean);
    const at = text.search(/^## Owner review\s*$/m);
    out.replies = at >= 0 ? text.slice(at).split(/\r?\n/).slice(1).filter((l) => /^- /.test(l)).map((l) => l.replace(/^- /, '').replace(/\*\*/g, '').replace(/ \(Brain Network\)$/, '')) : [];
    return out;
  }
  /* one Moon per piece of evidence: review images first, then files, the notes it links, and the notes linking here */
  async loadMoons(it) {
    const tok = this._moonTok = {};
    this.moons = []; this.moonLayer.empty(); this.evidence = null; this.allMoons = false;
    if (!it) return;
    const [media, ev] = await Promise.all([this.plugin.media(it), this.gatherEvidence(it)]);
    if (tok !== this._moonTok) return;
    const base = this.app.vault.adapter.getBasePath().replace(/\\/g, '/'), norm = (p) => (p || '').replace(/\\/g, '/').toLowerCase();
    const list = [], seen = new Set();
    for (const m of media) {
      if (seen.has(norm(m.abs))) continue;
      seen.add(norm(m.abs));
      list.push({ kind: m.kind, name: m.name, media: m, missing: !m.exists, path: m.abs });
    }
    for (const r of ev.files) {
      const path = r.missing || r.external || (r.file ? base + '/' + r.file.path : r.folder.path + '/');
      if (seen.has(norm(path))) continue;
      seen.add(norm(path));
      const name = path.replace(/\/+$/, '').split('/').pop() + (r.folder ? '/' : '');
      const kind = r.folder ? 'folder' : IMG_RE.test(path) ? 'img' : VID_RE.test(path) ? 'vid' : 'file';
      const src = kind === 'img' && !r.missing ? (r.file ? this.app.vault.getResourcePath(r.file) : this.plugin.externalSrc(path)) : null;
      list.push({ kind, name, ref: r, missing: !!r.missing, path, src });
    }
    ev.notes.forEach((r) => list.push({ kind: 'note', name: r.file.basename, ref: { file: r.file }, path: r.file.path }));
    ev.back.forEach((f) => list.push({ kind: 'back', name: f.basename, ref: { file: f }, path: f.path }));
    const cnt = (k) => list.filter((m) => k.includes(m.kind)).length, parts = [];
    const add = (n, one, many) => n && parts.push(`${n} ${n === 1 ? one : many}`);
    add(cnt(['img', 'vid']), 'image', 'images'); add(cnt(['file', 'folder']), 'file', 'files'); add(cnt(['note']), 'linked note', 'linked notes'); add(cnt(['back']), 'note linking here', 'notes linking here');
    ev.summary = parts.join(' · ');
    this.moons = list; this.evidence = ev;
    const shown = list.length > MOONS_MAX ? list.slice(0, MOONS_MAX - 1) : list;
    const viewable = list.filter((m) => m.media && m.media.exists);
    shown.forEach((m, i) => {
      const el = m.el = this.moonLayer.createDiv('bn-moon is-' + m.kind + (m.missing ? ' is-missing' : '') + ((m.media && m.media.exists) || m.src ? ' is-pic' : ''));
      el.style.setProperty('--i', String(i));
      if (m.media && m.media.exists && m.kind === 'img') el.createEl('img', { attr: { src: m.media.src, alt: '', loading: 'lazy' } });
      else if (m.media && m.media.exists && m.kind === 'vid') el.createEl('video', { attr: { src: m.media.src + '#t=0.5', preload: 'metadata', muted: '' } });
      else if (m.src) el.createEl('img', { attr: { src: m.src, alt: '', loading: 'lazy' } });
      else if (m.kind === 'file' && /\.\w{1,5}$/.test(m.name)) el.createDiv({ cls: 'bn-moon-ext', text: m.name.split('.').pop().slice(0, 4) });
      else setIcon(el.createDiv('bn-moon-ic'), { file: /\.(json|jsonl|csv|log|txt)$/i.test(m.name) ? 'file-text' : /\.(blend|fbx|obj|glb|usd\w?)$/i.test(m.name) ? 'box' : 'file', folder: 'folder', note: 'sticky-note', back: 'corner-up-left', vid: 'film', img: 'image' }[m.kind]);
      /* hover shows what the moon is, where it lives and what a click does; the moon itself stays put */
      const cap = el.createDiv('bn-moon-cap');
      cap.createDiv({ cls: 'bn-moon-name', text: m.name });
      const where = (m.path || '').replace(/\/+$/, '').split('/').slice(-3, -1).join('/');
      cap.createDiv({ cls: 'bn-moon-sub', text: [{ img: 'Image', vid: 'Clip', file: 'File', folder: 'Folder', note: 'Linked note', back: 'Links here' }[m.kind] || 'File', where].filter(Boolean).join(' · ') });
      cap.createDiv({ cls: 'bn-moon-hint', text: m.missing ? 'Not found on disk' : m.media && m.media.exists ? 'Click to view · double-click opens its app' : 'Click to open · double-click opens its app' });
      this.bindMoon(el, m, viewable);
    });
    if (list.length > MOONS_MAX) {
      const more = this.moonLayer.createDiv({ cls: 'bn-moon is-more', text: '+' + (list.length - shown.length) });
      more.style.setProperty('--i', String(shown.length));
      more.createDiv({ cls: 'bn-moon-cap', text: 'List them all in the Card' });
      more.onclick = () => { this.allMoons = true; this.renderPanel(); };
      this.moreMoon = more;
    } else this.moreMoon = null;
    this.renderPanel();
  }
  bindMoon(el, m, viewable) {
    if (m.missing) return;
    if (m.media && m.media.exists) {
      let tm = null;
      el.onclick = () => { if (tm) return; tm = setTimeout(() => { tm = null; this.openLightbox(viewable, viewable.indexOf(m)); }, 260); };
      el.ondblclick = () => { clearTimeout(tm); tm = null; openWithApp(m.media.abs.replace(/\\/g, '/')); };
    } else this.refs.bindRef(el, m.ref);
  }
  fileRow(list, m) {
    const row = list.createDiv('bn-file' + (m.missing ? ' is-missing' : ''));
    const ic = row.createSpan('bn-file-ic');
    setIcon(ic, { note: 'sticky-note', back: 'corner-up-left', folder: 'folder', img: 'image', vid: 'film' }[m.kind] || 'file');
    row.createSpan({ cls: 'bn-file-name', text: m.name });
    row.createSpan({ cls: 'bn-file-dir', text: (m.path || '').replace(/\/+$/, '').split('/').slice(-3, -1).join('/') });
    this.bindMoon(row, m, this.moons.filter((x) => x.media && x.media.exists));
  }
  /* each frame: the Card sits below the selected node (above it near the bottom edge), the Moons orbit the other side */
  overlayFrame(ctx) {
    const S = this.stage, n = this.sel && S.byId && S.byId.get(this.sel), card = this.card;
    this.overlay.style.opacity = String(S.alpha);
    if (!n || !card.isShown()) { this.overlay.addClass('is-off'); return; }
    const k = S.cam.k, cx = n.x * k + S.cam.x, cy = n.y * k + S.cam.y;
    const hw = (n.w ? n.w / 2 : n.r + 8) * k, hh = (n.w ? n.h / 2 : n.r + 8) * k;
    const L = this.leftInset(), R = S.W - this.rightInset(), T = 58, B = S.H - this.bottomInset() - 8;
    const off = cx < L - 20 || cx > R + 20 || cy < T - 40 || cy > B + 40;
    this.overlay.toggleClass('is-off', off);
    if (off) return;
    /* the Card never covers its node: it takes the side with room, and scrolls inside when neither side fits it */
    const nat = this._cardSize || { w: 340, h: 220 }, gap = 16;
    const roomBelow = B - (cy + hh + gap), roomAbove = (cy - hh - gap) - T;
    const below = roomBelow >= nat.h || roomBelow >= roomAbove;
    const room = Math.max(140, Math.floor(below ? roomBelow : roomAbove)), h = Math.min(nat.h, room);
    if (this._cardMax !== room) { this._cardMax = room; card.style.maxHeight = room + 'px'; }
    const sz = { w: nat.w, h };
    const top = below ? cy + hh + gap : cy - hh - gap - h;
    const left = Math.max(L + 12, Math.min(cx - sz.w / 2, R - sz.w - 12));
    card.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    /* a fine tether from the node to the Card */
    const tx = Math.max(left + 22, Math.min(cx, left + sz.w - 22)), ty0 = below ? cy + hh + 3 : cy - hh - 3, ty1 = below ? top : top + sz.h;
    ctx.strokeStyle = 'rgba(236,235,243,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, ty0); ctx.bezierCurveTo(cx, (ty0 + ty1) / 2, tx, (ty0 + ty1) / 2, tx, ty1); ctx.stroke();
    ctx.fillStyle = 'rgba(236,235,243,0.6)'; ctx.beginPath(); ctx.arc(cx, ty0, 1.8, 0, 6.283); ctx.fill();
    /* Moons: rings of an elliptical half-orbit on the side away from the Card */
    const els = [...this.moons.filter((m) => m.el).map((m) => m.el), ...(this.moreMoon ? [this.moreMoon] : [])];
    if (!els.length) return;
    const dir = below ? -1 : 1, rings = [];
    this.moonLayer.toggleClass('is-up', dir < 0);
    let left2 = els.length, ri = 0;
    while (left2 > 0) {
      const rx = hw + 46 + ri * 54, ry = hh + 42 + ri * 50;
      const cap = Math.max(3, Math.floor((Math.PI * Math.sqrt((rx * rx + ry * ry) / 2)) / 58));
      const m = Math.min(cap, left2);
      rings.push({ rx, ry, m }); left2 -= m; ri++;
    }
    let i = 0;
    ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(236,235,243,0.07)';
    for (const g of rings) {
      ctx.beginPath(); ctx.ellipse(cx, cy, g.rx, g.ry, 0, dir < 0 ? Math.PI : 0, dir < 0 ? Math.PI * 2 : Math.PI); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const g of rings) {
      for (let j = 0; j < g.m; j++, i++) {
        const el = els[i], a = dir < 0 ? Math.PI + ((j + 0.5) / g.m) * Math.PI : Math.PI - ((j + 0.5) / g.m) * Math.PI;
        const mx = cx + Math.cos(a) * g.rx, my = cy + Math.sin(a) * g.ry;
        const s = el._s || (el._s = el.offsetWidth || 36);
        /* the `translate` property, so the rise-in `scale` grows the moon in place instead of scaling its offset */
        el.style.translate = `${Math.round(mx - s / 2)}px ${Math.round(my - s / 2)}px`;
        /* tether from the node's rim toward the moon */
        const ex = cx + Math.cos(a) * hw, ey = cy + Math.sin(a) * hh, d = Math.hypot(mx - ex, my - ey) || 1, ux = (mx - ex) / d, uy = (my - ey) / d;
        const grad = ctx.createLinearGradient(ex, ey, mx, my);
        grad.addColorStop(0, 'rgba(236,235,243,0.16)'); grad.addColorStop(1, 'rgba(236,235,243,0.03)');
        ctx.strokeStyle = grad; ctx.beginPath(); ctx.moveTo(ex + ux * 3, ey + uy * 3); ctx.lineTo(mx - ux * (s / 2 + 3), my - uy * (s / 2 + 3)); ctx.stroke();
      }
    }
  }
  /* ---------- the brain's Claude session lives in the Chat ---------- */
  openSession(bid, about) {
    const b = bid && this.model.byBrain.get(bid);
    if (!b) { new Notice('Open a brain first.'); return; }
    this.plugin.openChat(b.id, about);
  }
  runsChanged() { this.renderBar(); this.renderInbox(); this.renderPanel(); }

  /* ---------- lightbox ---------- */
  openLightbox(items, i) { this.lb = { items, i }; this.lightbox.show(); this.renderLightbox(); this.contentEl.focus(); }
  closeLightbox() { this.lightbox.hide(); this.lightbox.empty(); this.lb = null; }
  lbStep(d) { if (!this.lb) return; this.lb.i = (this.lb.i + d + this.lb.items.length) % this.lb.items.length; this.renderLightbox(); }
  renderLightbox() {
    const L = this.lightbox, x = this.lb.items[this.lb.i];
    L.empty();
    L.onclick = (e) => { if (e.target === L) this.closeLightbox(); };
    const fig = L.createDiv('bn-lb-fig');
    if (x.kind === 'vid') fig.createEl('video', { attr: { src: x.src, controls: '', autoplay: '', loop: '' } });
    else fig.createEl('img', { attr: { src: x.src, alt: x.name } });
    const cap = L.createDiv('bn-lb-cap');
    cap.createSpan({ text: `${this.lb.i + 1} / ${this.lb.items.length} · ${x.name}` });
    const open = cap.createEl('button', { text: 'Open file' }); open.onclick = () => this.plugin.openExternal(x);
    const close = cap.createEl('button', { text: 'Close' }); close.onclick = () => this.closeLightbox();
    if (this.lb.items.length > 1) {
      const prev = L.createEl('button', { cls: 'bn-lb-nav is-prev', attr: { 'aria-label': 'Previous' } }); setIcon(prev, 'chevron-left'); prev.onclick = () => this.lbStep(-1);
      const next = L.createEl('button', { cls: 'bn-lb-nav is-next', attr: { 'aria-label': 'Next' } }); setIcon(next, 'chevron-right'); next.onclick = () => this.lbStep(1);
    }
  }
}

function chainFor(it) {
  const g = (GATE[it.gate] || 'gate').toLowerCase();
  const gate = it.gate ? [['Your ' + g, '']] : [];
  if (it.plan && !['done'].includes(it.state)) {
    if (it.state === 'owner') return [['Your ' + (it.gate === 'decision' ? 'decision' : g), 'cur']];
    if (it.state === 'parked') return [['Parked', 'cur']];
    return [['Planned', 'cur'], ['Brief', ''], ['Codex runs', ''], ['Claude verifies', '']];
  }
  switch (it.state) {
    case 'codex': return [['Brief ready', 'ok'], ['Codex runs', 'cur'], ['Claude verifies', ''], ...gate];
    case 'claude': return [['Codex ran', 'ok'], ['Claude verifies', 'cur'], ...gate];
    case 'owner': return [['Codex ran', 'ok'], ['Claude verified', it.verified === false ? 'unk' : 'ok'], [it.gate === 'decision' ? 'Your decision' : 'Your ' + g, 'cur']];
    case 'done': return [['Finished', 'ok']];
    case 'parked': return [['Parked', 'cur']];
    default: return [['Planned', 'cur']];
  }
}
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m === 1 ? 'a minute ago' : m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)} h ago`;
}
function toolSummary(inp) {
  if (!inp || typeof inp !== 'object') return '';
  const v = inp.file_path || inp.path || (inp.command && inp.description) || inp.command || inp.pattern || inp.url || inp.description || inp.prompt || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 140);
}
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
const usd = (n) => '$' + (n || 0).toFixed(n >= 1 ? 2 : 3);
const MODELS = [['', 'CLI default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['claude-fable-5-1', 'Fable']];
const EFFORTS = [['', 'CLI default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const FRESH = [[0, 'Never'], [100000, '100k tokens'], [150000, '150k tokens'], [200000, '200k tokens'], [300000, '300k tokens']];
const MODES = [['bypassPermissions', 'Everything: no permission checks (web, commands, any file)'], ['acceptEdits', 'Notes only: edits allowed, commands refused'], ['auto', 'Auto: a safety check approves routine actions'], ['plan', 'Plan only: reads and proposes, changes nothing']];
const today = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

class NameModal extends Modal {
  constructor(app, value, done) { super(app); this.value = value; this.done = done; }
  onOpen() {
    this.titleEl.setText('Make this note a brain');
    this.contentEl.createEl('p', { text: 'The note becomes the front page of a brain named:' });
    const inp = this.contentEl.createEl('input', { type: 'text', value: this.value, cls: 'bn-name' });
    const ok = this.contentEl.createEl('button', { text: 'Make brain', cls: 'mod-cta' });
    const go = () => { const v = inp.value.trim(); if (v) { this.close(); this.done(v); } };
    ok.onclick = go; inp.onkeydown = (e) => e.key === 'Enter' && go();
    setTimeout(() => inp.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

/* ----------------------------------------------------------------- plugin */
/* ------------------------------------------------------------------ chat */
/* A full-size chat with one brain's Claude session. It reads the CLI's own transcript
   (~/.claude/projects/<vault>/<session>.jsonl), so messages sent from the map and from a terminal both show, with every
   tool call and result, exactly as the CLI recorded them. Sending goes through the plugin's dispatcher. */
const CHAT = 'brain-network-chat';
function transcriptPath(base, sid) {
  const root = nodePath.join(require('os').homedir(), '.claude', 'projects');
  const direct = nodePath.join(root, base.replace(/[^A-Za-z0-9]/g, '-'), sid + '.jsonl');
  if (fs.existsSync(direct)) return direct;
  try { for (const d of fs.readdirSync(root)) { const p = nodePath.join(root, d, sid + '.jsonl'); if (fs.existsSync(p)) return p; } } catch (e) { /* no projects dir */ }
  return direct;
}
/* the map's messages carry a header line and, on a session's first message, instructions; show only your words */
function ownerWords(text) {
  const m = text.match(/^\[Brain Network · ([^\]\n]*)\]([^\n]*)\n/);
  if (!m) return null;
  let body = text.slice(m[0].length).replace(/^\n+/, '');
  body = body.split(/\n\n---\nBrain Network instructions|\n\nYou are the [^\n]* brain's Claude session/)[0];
  const about = (m[1] + m[2]).match(/about "([^"]+)"/);
  return { text: body.trim(), about: about ? about[1] : null };
}
function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

/* Turns paths into things you can open, for one brain: vault notes (at a line), folders, files on disk, and files that
   moved. Shared by the chat and the node pane. */
class Refs {
  constructor(plugin, getBrain) { this.plugin = plugin; this.app = plugin.app; this.getBrain = getBrain; }
  get brainId() { return this.getBrain(); }
  brain() { return this.plugin.model && this.plugin.model.byBrain.get(this.brainId); }
  /* Paths Claude mentions: "Email Drafts/", "Projects/X/Note.md:42", "D:/…/x.png", and paths outside the vault written
     relative to a project ("Builds/…/x.mp4") or to a path named earlier in the same answer ("after/x.png").
     Order: the brain's folder, the vault, note names, then outside the vault: the brain's review files, folders named
     earlier in the answer, and the project roots this brain's notes point at. */
  resolveRef(raw, ctx) {
    let t = String(raw).trim().replace(/^[`'"<(\[]+|[`'">)\],;]+$/g, '').replace(/\\/g, '/');
    let line = null;
    const m = t.match(/^(.*?\S)(?::|#L| line )(\d+)(?:[-–]\d+)?$/);
    if (m && !/^[A-Za-z]$/.test(m[1])) { t = m[1]; line = parseInt(m[2], 10); }
    t = t.replace(/^file:\/\/\/?/i, '').replace(/\.$/, '');
    try { t = decodeURIComponent(t); } catch (e) { /* keep as is */ }
    if (!t || t.length > 400 || /^(https?|mailto):/i.test(t) || !/[\/.]/.test(t)) return null;
    const base = this.app.vault.adapter.getBasePath().replace(/\\/g, '/'), V = this.app.vault;
    if (/^[A-Za-z]:\//.test(t) || t.startsWith('/')) {
      if (t.toLowerCase().startsWith(base.toLowerCase() + '/')) t = t.slice(base.length + 1);
      else return fs.existsSync(t) ? { external: t, line } : this.moved(t, line);
    }
    const clean = t.replace(/^\.\//, '').replace(/\/+$/, ''), b = this.brain(), cands = [];
    if (b && b.folder) cands.push(b.folder + '/' + clean);
    cands.push(clean);
    for (const c of cands) {
      for (const x of [c, c + '.md']) {
        const f = V.getAbstractFileByPath(x);
        if (f) return f.children ? { folder: f } : { file: f, line };
      }
    }
    const d = this.app.metadataCache.getFirstLinkpathDest(clean, b ? b.file : '');
    if (d) return { file: d, line };
    const tail = '/' + clean.toLowerCase();
    const hit = this.extFiles().find((p) => p.toLowerCase().replace(/\/+$/, '').endsWith(tail));
    if (hit && fs.existsSync(hit)) return { external: hit, line };
    for (const dir of [...((ctx && ctx.dirs) || []), ...this.extRoots()]) {
      const p = dir + '/' + clean;
      if (fs.existsSync(p)) return { external: p, line };
    }
    return hit ? this.moved(hit, line) : null;
  }
  /* a file a note names that is no longer there: look for the same name near where it was (cached) */
  moved(p, line) {
    this._moved = this._moved || new Map();
    if (!this._moved.has(p)) {
      const name = p.replace(/\/+$/, '').split('/').pop().toLowerCase();
      let dir = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/'), found = null;
      while (dir.split('/').length > 2 && !fs.existsSync(dir)) dir = dir.split('/').slice(0, -1).join('/');
      for (let up = 0; up < 3 && !found && dir.split('/').length > 2; up++) {
        const q = [[dir, 0]];
        let seen = 0;
        while (q.length && !found && seen < 4000) {
          const [d, depth] = q.shift();
          let ents = [];
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
          for (const e of ents) {
            seen++;
            if (e.name.toLowerCase() === name) { found = d + '/' + e.name; break; }
            if (e.isDirectory() && depth < 4 && !/^(\.git|Library|Temp|Logs|node_modules)$/.test(e.name)) q.push([d + '/' + e.name, depth + 1]);
          }
        }
        dir = dir.split('/').slice(0, -1).join('/');
      }
      this._moved.set(p, found);
    }
    const m = this._moved.get(p);
    return m ? { external: m, line, movedFrom: p } : { missing: p };
  }
  /* one click: open in an Obsidian tab; double-click: open in the file's own app */
  bindRef(el, r, toolInput) {
    let tm = null;
    el.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (tm) return; tm = setTimeout(() => { tm = null; this.openRef(r, toolInput); }, 260); };
    el.ondblclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); clearTimeout(tm); tm = null; this.openRef(r, toolInput, 'app'); };
  }
  /* absolute paths this brain's items and front pages mention, and the folders above them (cached for a minute) */
  extFiles() { return this.ext().files; }
  extRoots() { return this.ext().roots; }
  ext() {
    if (this._ext && this._ext.brain === this.brainId && Date.now() - this._ext.at < 60000) return this._ext;
    const b = this.brain(), files = new Set(), roots = new Set(), base = this.app.vault.adapter.getBasePath();
    const add = (raw) => {
      let p = String(raw).replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/');
      try { p = decodeURIComponent(p); } catch (e) { /* keep */ }
      if (!/^[A-Za-z]:\//.test(p)) return;
      files.add(p);
      const parts = p.replace(/\/+$/, '').split('/');
      for (let i = parts.length - 1; i >= 2; i--) roots.add(parts.slice(0, i).join('/'));
    };
    if (b) {
      b.items.forEach((it) => it.review.forEach(add));
      for (const f of [b.file, (b.folder ? b.folder + '/' : '') + 'AGENTS.md']) {
        try { (fs.readFileSync(nodePath.join(base, f), 'utf8').match(/[A-Za-z]:[\\/][^\s`'"()<>\]|*?]+/g) || []).forEach(add); } catch (e) { /* no such note */ }
      }
    }
    const R = [...roots].filter((r) => { try { return fs.statSync(r).isDirectory(); } catch (e) { return false; } }).sort((x, y) => y.length - x.length).slice(0, 40);
    this._ext = { brain: this.brainId, at: Date.now(), files: [...files], roots: R };
    return this._ext;
  }
  linkify(el) {
    const ctx = { dirs: [] };
    el.querySelectorAll('code').forEach((c) => {
      if (c.closest('pre') || c.hasClass('bnc-ref')) return;
      const r = this.resolveRef(c.textContent, ctx);
      if (!r) return;
      if (r.missing) { c.addClass('bnc-missing'); c.setAttr('aria-label', 'Not found on disk: ' + r.missing); return; }
      if (r.external) {
        /* later relative paths in this answer may be relative to this one */
        const p = r.external.replace(/\/+$/, ''), isDir = (() => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } })();
        const parts = p.split('/'), dirs = [];
        for (let i = parts.length - (isDir ? 0 : 1); i >= Math.max(3, parts.length - 3); i--) dirs.push(parts.slice(0, i).join('/'));
        ctx.dirs = [...dirs, ...ctx.dirs.filter((x) => !dirs.includes(x))].slice(0, 12);
      }
      c.addClass('bnc-ref');
      c.setAttr('aria-label', (r.folder ? 'Show folder ' + r.folder.path : r.external ? 'Open ' + r.external : 'Open ' + r.file.path + (r.line ? ' at line ' + r.line : ''))
        + (r.movedFrom ? '. Moved: the path written here no longer exists' : '') + '. Double-click: its own app');
      if (r.movedFrom) c.addClass('bnc-moved');
      this.bindRef(c, r);
    });
  }
  /* files open in the map's tab group so the chat stays in view; a line, or the place an edit landed, is scrolled to */
  async openRef(r, toolInput, how) {
    const base = this.app.vault.adapter.getBasePath().replace(/\\/g, '/');
    if (r.missing) return;
    if (how === 'app') { openWithApp(r.external || base + '/' + (r.file || r.folder).path); return; }
    if (r.external) { this.plugin.openFileTab(r.external); return; }
    if (r.folder) {
      const fe = this.app.workspace.getLeavesOfType('file-explorer')[0];
      if (fe) { this.app.workspace.revealLeaf(fe); fe.view.revealInFolder && fe.view.revealInFolder(r.folder); }
      return;
    }
    /* files Obsidian cannot show (.eml, .docx, .blend…) open in their own app */
    const vr = this.app.viewRegistry;
    if (vr && vr.isExtensionRegistered && !vr.isExtensionRegistered(r.file.extension)) { this.plugin.openFileTab(base + '/' + r.file.path); this.revealInExplorer(r.file); return; }
    let line = r.line;
    if (!line && toolInput) {
      if (toolInput.offset) line = toolInput.offset;
      const needle = String(toolInput.new_string || toolInput.content || '').split('\n').find((x) => x.trim().length > 3);
      if (!line && needle && r.file.extension === 'md') {
        const text = await this.app.vault.cachedRead(r.file), i = text.indexOf(needle);
        if (i >= 0) line = text.slice(0, i).split('\n').length;
      }
    }
    const map = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (map) this.app.workspace.setActiveLeaf(map, { focus: false });
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(r.file, { active: true, eState: line ? { line: line - 1 } : undefined });
    const ed = leaf.view && leaf.view.editor;
    if (line && ed) { const pos = { line: line - 1, ch: 0 }; ed.setCursor(pos); ed.scrollIntoView({ from: pos, to: pos }, true); }
    this.revealInExplorer(r.file, leaf);
  }
  /* expand the file's folders in the file explorer and highlight it there, then hand focus back to the opened tab */
  revealInExplorer(file, leaf) {
    const fe = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (!fe || !fe.view.revealInFolder) return;
    fe.view.revealInFolder(file);
    /* the explorer makes itself the active pane a moment after revealing, so hand focus back after it */
    if (leaf) setTimeout(() => this.app.workspace.setActiveLeaf(leaf, { focus: true }), 60);
  }
  linkClick(ev) {
    const a = ev.target.closest && ev.target.closest('a');
    if (!a) return;
    const href = a.getAttr('data-href') || a.getAttr('href') || '';
    if (/^(https?|mailto):/i.test(href)) return;
    ev.preventDefault();
    const r = this.resolveRef(href);
    if (r) this.openRef(r);
    else this.app.workspace.openLinkText(href, this.brain() ? this.brain().file : '', 'tab');
  }
}

/* The old separate chat tab; kept so a tab saved in the workspace still opens. The chat now lives in the map's drawer. */
class ChatView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return CHAT; }
  getDisplayText() { return 'Claude'; }
  getIcon() { return 'bot'; }
  async onOpen() { this.panel = new ChatPanel(this.plugin, this.contentEl, {}); this.addChild(this.panel); }
}

class ChatPanel extends Component {
  constructor(plugin, host, opts) {
    super();
    this.plugin = plugin; this.app = plugin.app; this.contentEl = host; this.opts = opts || {};
    this.brainId = null; this.lane = ''; this.viewing = null; this.about = null; this.draft = '';
    this.refs = new Refs(plugin, () => this.brainId);
    this.reset();
  }
  reset() { this.tr = { file: null, size: 0, rest: '', blocks: [], tools: new Map(), rendered: 0, turn: null }; }
  scrollEnd() { if (this.logEl) this.logEl.scrollTop = this.logEl.scrollHeight; }
  brain() { return this.plugin.model && this.plugin.model.byBrain.get(this.brainId); }
  cfg() { return this.plugin.brainCfg(this.brainId); }
  /* the session slot of the strand this Chat shows: '' is the brain's General session */
  slot() { return this.plugin.slot(this.brainId, this.lane); }
  sid() { return this.viewing || this.slot().session; }
  laneName(l) { return l || 'General'; }
  onload() {
    this.contentEl.addClass('bnc-root');
    this.registerInterval(window.setInterval(() => this.poll(), 700));
    this.build();
  }
  /* switching brain or strand reloads the transcript; the same strand only updates what the next message is about.
     Selecting a node shows its strand's session, and a node without a strand shows the General session; deselecting keeps the current one. */
  setBrain(bid, about, focus) {
    let changed = bid !== this.brainId;
    if (changed) { this.brainId = bid; this.lane = ''; this.viewing = null; this.reset(); }
    if (about !== undefined) {
      /* only a new selection moves the Chat to another strand; rebuilds that re-send the same node leave your pick alone */
      const moved = changed || about !== this.about, lane = this.plugin.laneOf(about);
      this.about = about;
      /* deselecting (about becomes null) keeps the strand you were in; selecting a node moves to its strand */
      if (moved && (about || changed) && lane !== this.lane) { this.lane = lane; this.viewing = null; this.reset(); changed = true; }
    }
    if (changed || !this.head) this.build(); else this.renderAbout();
    if (focus) setTimeout(() => this.input && this.input.focus(), 50);
  }
  /* ---------- skeleton ---------- */
  build() {
    const root = this.contentEl;
    if (!this.plugin.model) return;
    root.empty();
    this.reset();
    const b = this.brain();
    this.head = root.createDiv('bnc-head');
    this.logEl = root.createDiv('bnc-log');
    this.col = this.logEl.createDiv('bnc-col');
    this.tail = this.logEl.createDiv('bnc-col bnc-tail');
    this.foot = root.createDiv('bnc-foot');
    let lastTop = 0, upBy = 0;
    this.logEl.addEventListener('scroll', () => {
      const top = this.logEl.scrollTop, d = top - lastTop; lastTop = top;
      upBy = d < 0 ? upBy - d : 0;
      if (upBy > 40) this.shrinkComposer();
    }, { passive: true });
    if (!b) { this.col.createDiv({ cls: 'bnc-empty', text: 'Pick a brain to talk to.' }); this.renderHead(); return; }
    this.renderHead(); this.renderComposer();
    this.poll(true);
  }
  renderHead() {
    const h = this.head, P = this.plugin; h.empty();
    const b = this.brain();
    if (this.opts.embedded) { const t = h.createDiv({ cls: 'bnc-title' }); t.createDiv({ cls: 'bn-eyebrow', text: 'Chat' }); t.createDiv({ cls: 'bnc-title-name', text: b ? b.name : 'Pick a brain' }); }
    else {
      const pick = h.createEl('select', { cls: 'dropdown bnc-brain' });
      P.model.brains.forEach((x) => pick.createEl('option', { value: x.id, text: x.name }));
      if (this.brainId) pick.value = this.brainId; else pick.createEl('option', { value: '', text: 'Choose a brain' }).selected = true;
      pick.onchange = () => this.setBrain(pick.value, null, true);
    }
    if (!b) return;
    const cfg = this.slot(), meta = h.createDiv('bnc-meta');
    /* sessions: one per strand (General for the rest), each with earlier ones you can read back or continue */
    const pick = meta.createEl('button', { cls: 'bnc-chip bnc-sess', text: `${this.laneName(this.lane)} · ${this.viewing ? 'earlier ' + this.viewing.slice(0, 8) : cfg.session ? 'current session' : 'new session'}`, attr: { 'aria-label': 'Sessions: one per strand, running side by side' } });
    pick.onclick = (e) => this.sessionMenu(e, pick);
    const c = cfg.ctx;
    if (c && c.used && !this.viewing) {
      const pct = c.window ? (c.used / c.window) * 100 : null;
      const fresh = P.settings.dispatch.freshAt;
      const ctx = meta.createDiv({ cls: 'bnc-ctx' + (pct > 80 || (fresh && c.used > fresh) ? ' is-high' : ''), attr: { 'aria-label': `Context after the last message: ${c.used.toLocaleString()} tokens${c.window ? ' of ' + c.window.toLocaleString() : ''}${fresh ? `. Past ${kfmt(fresh)}, the next message starts a fresh session.` : ''}` } });
      const ring = ctx.createDiv('bnc-ring'); ring.style.setProperty('--p', String(pct || 0));
      ctx.createSpan({ text: `${kfmt(c.used)}${c.window ? ' / ' + kfmt(c.window) : ''}` });
    }
    const runs = P.runsFor(b.id).filter((r) => r.session === this.sid() || r.resumed === this.sid());
    if (runs.length) {
      const cost = runs.reduce((a, r) => a + (r.cost || 0), 0), out = runs.reduce((a, r) => a + (r.usage ? r.usage.out : 0), 0);
      meta.createSpan({ cls: 'bnc-pill', text: `${runs.length} message${runs.length === 1 ? '' : 's'} · ${kfmt(out)} out · ${usd(cost)}`, attr: { 'aria-label': 'Tokens and cost of messages sent from the map, as the CLI reported them' } });
    }
    h.createDiv('bn-spacer');
    const btn = (icon, label, fn) => { const x = h.createEl('button', { cls: 'bnc-icon', attr: { 'aria-label': label } }); setIcon(x, icon); x.onclick = fn; return x; };
    if (!this.opts.embedded) btn('map', 'Show this brain on the map', () => P.activate().then(() => { const v = P.views()[0]; if (v && b.items.length) v.enterStrand(b.id); }));
    btn('terminal-square', 'Open this session in a terminal. Do not send from here while it is open.', () => P.openTerminal(b.id, this.lane));
    btn('plus-circle', 'New session for this strand: the next message starts fresh; this one stays readable under earlier sessions', () => {
      if (P.runningIn(b.id, this.lane)) { new Notice('Wait for the running message to finish.'); return; }
      P.newSession(b.id, this.lane); this.viewing = null; this.build();
    });
  }
  /* the session picker: strands (and side sessions) of this brain, this strand's earlier sessions, and when to start fresh */
  sessionMenu(e, anchor) {
    const P = this.plugin, b = this.brain(), cfg = this.cfg(), D = P.settings.dispatch, menu = new Menu();
    const head = (t) => menu.addItem((i) => i.setTitle(t).setDisabled(true));
    const lanes = ['', ...new Set([...b.items.map((i) => i.stream).filter(Boolean), ...Object.keys(cfg.lanes || {})])];
    head('Sessions in ' + b.name);
    lanes.forEach((l) => {
      const sl = P.slot(b.id, l), run = P.runsFor(b.id, l).find((r) => r.status === 'running');
      const info = run ? 'working' : sl.ctx && sl.ctx.used && sl.session ? kfmt(sl.ctx.used) : sl.session ? 'open' : 'none yet';
      menu.addItem((i) => i.setTitle(`${this.laneName(l)} · ${info}`).setChecked(l === this.lane && !this.viewing).onClick(() => { this.lane = l; this.viewing = null; this.build(); }));
    });
    menu.addItem((i) => i.setTitle('New side session').setIcon('plus').onClick(() => {
      let n = 1; while ((cfg.lanes || {})['Side ' + n]) n++;
      P.slot(b.id, 'Side ' + n); P.saveSettings(); this.lane = 'Side ' + n; this.viewing = null; this.build();
    }));
    const past = this.slot().past || [];
    if (past.length) {
      menu.addSeparator(); head('Earlier in ' + this.laneName(this.lane));
      past.forEach((s) => menu.addItem((i) => i.setTitle('Earlier session ' + s.slice(0, 8)).setChecked(this.viewing === s).onClick(() => { this.viewing = s; this.build(); })));
    }
    menu.addSeparator(); head('Start a fresh session after');
    FRESH.forEach(([v, l]) => menu.addItem((i) => i.setTitle(l).setChecked((D.freshAt || 0) === v).onClick(() => { D.freshAt = v; P.saveSettings(); this.renderHead(); })));
    const r = anchor.getBoundingClientRect();
    if (e.clientX || e.clientY) menu.showAtMouseEvent(e); else menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
  }
  /* The message box is built once per brain and never rebuilt while you type: what changes around it (the node it is
     about, attachments, the model and stop controls) re-renders in its own slot. */
  renderComposer() {
    const f = this.foot, P = this.plugin, b = this.brain(); f.empty();
    this.input = null; this.aboutEl = null;
    if (!b) return;
    const box = this.box = f.createDiv('bnc-box');
    if (this.viewing) {
      box.addClass('is-past');
      box.createDiv({ cls: 'bnc-note', text: 'You are reading an earlier session.' });
      const cont = box.createEl('button', { text: 'Continue this session', cls: 'mod-cta' });
      cont.onclick = () => { if (P.runningIn(b.id, this.lane)) { new Notice('Wait for the running message to finish.'); return; } P.resumeSession(b.id, this.viewing, this.lane); this.viewing = null; this.build(); };
      return;
    }
    this.aboutEl = box.createDiv('bnc-aboutslot');
    this.attEl = box.createDiv('bnc-att');
    const ta = this.input = box.createEl('textarea', { cls: 'bnc-input', attr: { rows: 1 } });
    ta.value = this.draft;
    this.ctrlEl = box.createDiv('bnc-row');
    const grow = this.grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, Math.round(this.contentEl.clientHeight * 0.4)) + 'px'; };
    ta.oninput = () => { this.draft = ta.value; grow(); };
    requestAnimationFrame(grow);
    requestAnimationFrame(() => this.clearStatusBar());
    this.peekEl = box.createDiv('bnc-peek');
    box.onmouseenter = () => { clearTimeout(this._hoverT); if (box.hasClass('is-shrunk')) this._hoverT = setTimeout(() => this.expandComposer(), 70); };
    box.onmouseleave = () => clearTimeout(this._hoverT);
    this.peekEl.onclick = () => this.expandComposer();
    /* Enter sends, Shift+Enter is a new line; never send while an input method is composing (Chinese, Japanese…) */
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); this.send(); } };
    /* a pasted screenshot is saved as a vault attachment next to the brain's front page */
    ta.onpaste = (e) => {
      const files = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (!files.length) return;
      e.preventDefault();
      Promise.all(files.map((x) => { let p = ''; try { p = require('electron').webUtils.getPathForFile(x); } catch (y) { /* no path */ } return p ? this.attachPath(p) : this.saveBlob(x); }))
        .then((a) => this.addAttachments(a)).catch((x) => new Notice('Could not attach: ' + x.message));
    };
    this.renderAbout(); this.renderAtt(); this.renderControls();
  }
  /* Obsidian's status bar floats over the bottom right of the window; keep the message box above it */
  clearStatusBar() {
    const bar = document.querySelector('.status-bar'), f = this.foot;
    if (!f) return;
    f.style.paddingBottom = '';
    if (!bar || !bar.offsetParent && getComputedStyle(bar).position !== 'fixed') return;
    const a = bar.getBoundingClientRect(), r = this.contentEl.getBoundingClientRect();
    const over = a.left < r.right && a.right > r.left && r.height ? Math.max(0, Math.min(r.bottom, a.bottom) - a.top) : 0;
    if (over) f.style.paddingBottom = Math.round(over + 6) + 'px';
  }
  /* Scrolling up to read folds a long message box to the line the caret is on; hovering it brings the box back with
     the caret and selection where they were, ready to type. Short drafts stay as they are. */
  shrinkComposer() {
    const ta = this.input, box = this.box;
    if (!ta || !box || box.hasClass('is-shrunk')) return;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22;
    if (ta.offsetHeight < lh * 2.5) return;
    this.caret = { start: ta.selectionStart, end: ta.selectionEnd, dir: ta.selectionDirection, top: ta.scrollTop, focused: document.activeElement === ta };
    const v = ta.value, a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1, z = v.indexOf('\n', ta.selectionStart);
    this.morphBox(() => {
      this.peekEl.setText(v.slice(a, z < 0 ? v.length : z).trim() || v.trim().split('\n')[0]);
      box.addClass('is-shrunk');
      this.clearStatusBar();
    });
  }
  /* run a change to the box, then ease its height from the old size to the new one and fade its contents in */
  morphBox(change) {
    const box = this.box, from = box.getBoundingClientRect().height;
    if (this._boxAnim) this._boxAnim.cancel();
    change();
    const to = box.getBoundingClientRect().height;
    if (calm() || Math.abs(from - to) < 2) return;
    box.style.overflow = 'hidden';
    const a = this._boxAnim = box.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 220, easing: 'cubic-bezier(.2, .7, .2, 1)' });
    a.onfinish = a.oncancel = () => { if (this._boxAnim === a) { box.style.overflow = ''; this._boxAnim = null; } };
    for (const el of box.children) if (el.offsetParent) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 60, easing: 'ease-out', fill: 'backwards' });
  }
  expandComposer() {
    const ta = this.input, box = this.box;
    if (!ta || !box || !box.hasClass('is-shrunk')) return;
    this.morphBox(() => { box.removeClass('is-shrunk'); this.grow(); });
    const c = this.caret;
    ta.focus({ preventScroll: true });
    if (c) { ta.setSelectionRange(c.start, c.end, c.dir); ta.scrollTop = c.top; }
  }
  aboutItem() { return this.about && this.plugin.model && this.plugin.model.byItem.get(this.about); }
  renderAbout() {
    if (!this.aboutEl) return;
    const el = this.aboutEl, b = this.brain(); el.empty();
    const it = this.aboutItem();
    if (this.about && !it) this.about = null;
    if (it) {
      const chip = el.createDiv('bnc-about' + (it.state === 'owner' ? ' is-reply' : ''));
      chip.createSpan({ cls: 'bn-dot bn-' + it.state });
      chip.createSpan({ text: (it.state === 'owner' ? 'Your reply on ' : 'About ') + it.title });
      if (it.state === 'owner') chip.createSpan({ cls: 'bnc-about-sub', text: 'saved under Owner review' });
      const x = chip.createEl('button', { cls: 'bn-x', attr: { 'aria-label': 'Not about this item' } }); setIcon(x, 'x');
      x.onclick = () => { this.about = null; this.renderAbout(); };
    }
    if (this.input) this.input.placeholder = it ? (it.state === 'owner' ? 'What you think, what to change, a question…' : `Message ${b.name} about this node…`) : `Message ${b.name}…`;
  }
  renderAtt() {
    if (!this.attEl) return;
    const el = this.attEl; el.empty();
    (this.att || []).forEach((a, i) => {
      const c = el.createDiv({ cls: 'bnc-attchip', attr: { 'aria-label': a.path } });
      if (a.src) c.createEl('img', { attr: { src: a.src, alt: '' } }); else setIcon(c.createSpan('bnc-attic'), a.dir ? 'folder' : 'file');
      c.createSpan({ cls: 'bnc-attname', text: a.name });
      const x = c.createEl('button', { cls: 'bn-x', attr: { 'aria-label': 'Remove' } }); setIcon(x, 'x');
      x.onclick = () => { this.att.splice(i, 1); this.renderAtt(); };
    });
  }
  renderControls() {
    if (!this.ctrlEl) return;
    const a = document.activeElement;
    if (a && this.ctrlEl.contains(a) && a.tagName === 'SELECT') return;
    const row = this.ctrlEl, P = this.plugin, D = P.settings.dispatch, cfg = this.cfg(), b = this.brain(); row.empty();
    /* each chip opens Obsidian's own menu: native selects draw a white popup on Windows that the night palette can't style */
    const sel = (opts, cur, def, label, set) => {
      const name = (v) => (opts.find((m) => m[0] === (v || '')) || opts[0])[1].split(':')[0].replace('CLI default', 'default');
      const chip = row.createEl('button', { cls: 'bnc-chip', text: `${label} · ${name(cur || def)}`, attr: { 'aria-label': label } });
      chip.onclick = (e) => {
        const r = chip.getBoundingClientRect(), menu = new Menu();
        const pick = (v, title) => menu.addItem((i) => i.setTitle(title).setChecked((cur || null) === v).onClick(() => { set(v); P.saveSettings(); this.renderControls(); }));
        pick(null, def ? `Default · ${name(def)}` : 'Default · let the CLI choose');
        opts.filter((m) => m[0]).forEach(([v, l]) => pick(v, l));
        if (e.clientX || e.clientY) menu.showAtMouseEvent(e); else menu.showAtPosition({ x: r.left, y: r.top });
      };
    };
    sel(MODELS, cfg.model, D.model, 'Model', (v) => { cfg.model = v; });
    sel(EFFORTS, cfg.effort, D.effort, 'Effort', (v) => { cfg.effort = v; });
    sel(MODES, cfg.mode, D.mode, 'Access', (v) => { cfg.mode = v; });
    row.createDiv('bn-spacer');
    const running = P.runsFor(b.id, this.lane).find((r) => r.status === 'running');
    if (running) { const stop = row.createEl('button', { cls: 'bnc-stop', text: 'Stop' }); stop.onclick = () => P.stopRun(running); }
    const send = row.createEl('button', { cls: 'bnc-send mod-cta', attr: { 'aria-label': 'Send (Enter)' } }); setIcon(send, 'arrow-up');
    send.onclick = () => this.send();
  }
  /* A message about a node that waits on you is your reply: saved under Owner review, then sent to Claude.
     Anything else is a message in this brain's session. Attachments go as paths Claude can read. */
  send() {
    const P = this.plugin, D = P.settings.dispatch, b = this.brain(), ta = this.input;
    if (!b || !ta) return;
    const att = this.att || [];
    const text = (ta.value.trim() + (att.length ? `\n\nAttached (read these):\n${att.map((a) => '- `' + a.path + '`').join('\n')}` : '')).trim();
    if (!text) return;
    const it = this.aboutItem(), reply = it && it.state === 'owner';
    if (!reply && !D.on) { new Notice('Sending to Claude is off in Brain Network settings.'); return; }
    const clear = () => { this.draft = ''; ta.value = ''; this.att = []; this.renderAtt(); this.grow && this.grow(); this.stick = true; this.renderTail(); };
    try {
      if (reply) P.reply(it, 'reply', text, 'Send to Claude').then(() => P.runsChanged(true)).catch((e) => { console.error(e); new Notice('Brain Network could not write the reply: ' + e.message); });
      else P.dispatch({ brain: b.id, item: it ? it.id : null, file: it ? it.file : null, title: it ? it.title : b.name, text, lane: this.lane });
      clear();
    } catch (e) { new Notice(e.message); }
  }
  /* ---------- attachments ---------- */
  attachVault(f) {
    return { path: f.path, name: f.name, src: IMG_RE.test(f.name) ? this.app.vault.getResourcePath(f) : null };
  }
  attachPath(abs) {
    abs = abs.replace(/\\/g, '/');
    const base = this.app.vault.adapter.getBasePath().replace(/\\/g, '/');
    if (abs.toLowerCase().startsWith(base.toLowerCase() + '/')) {
      const f = this.app.vault.getAbstractFileByPath(abs.slice(base.length + 1));
      if (f && f.extension) return this.attachVault(f);
    }
    let dir = false;
    try { dir = fs.statSync(abs).isDirectory(); } catch (e) { /* gone */ }
    return { path: abs, name: abs.replace(/\/+$/, '').split('/').pop() + (dir ? '/' : ''), dir, src: IMG_RE.test(abs) ? this.plugin.externalSrc(abs) : null };
  }
  async saveBlob(file) {
    const d = new Date(), p = (x) => String(x).padStart(2, '0');
    const ext = ((file.type || '').split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
    const name = file.name && !/^image\.\w+$/.test(file.name) ? file.name : `Pasted ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
    const b = this.brain(), dest = await this.app.fileManager.getAvailablePathForAttachment(name, b ? b.file : '');
    const tf = await this.app.vault.createBinary(dest, await file.arrayBuffer());
    return this.attachVault(tf);
  }
  addAttachments(list) {
    this.att = this.att || [];
    for (const a of list) if (a && !this.att.some((x) => x.path === a.path)) this.att.push(a);
    this.renderAtt();
  }
  /* ---------- transcript ---------- */
  poll(force) {
    if (!this.brain() || !this.col) return;
    const sid = this.sid();
    if (!sid) { if (force || !this.tr.emptyShown) this.showEmpty(); this.renderTail(); return; }
    const file = transcriptPath(this.app.vault.adapter.getBasePath(), sid);
    if (this.tr.file !== file) { this.reset(); this.tr.file = file; this.col.empty(); }
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) { this.renderTail(); return; }
    if (size > this.tr.size) {
      const fd = fs.openSync(file, 'r'), len = size - this.tr.size, buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.tr.size); fs.closeSync(fd);
      this.tr.size = size;
      const text = this.tr.rest + buf.toString('utf8'), lines = text.split('\n');
      this.tr.rest = lines.pop();
      const near = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 160 || this.stick || force;
      for (const l of lines) { if (!l.trim()) continue; try { this.ingest(JSON.parse(l)); } catch (e) { /* torn line */ } }
      this.renderBlocks();
      this.tr.live = true;
      if (near) requestAnimationFrame(() => { this.logEl.scrollTop = this.logEl.scrollHeight; });
      this.stick = false;
    }
    this.renderTail();
  }
  showEmpty() {
    this.col.empty(); this.tr.emptyShown = true;
    const e = this.col.createDiv('bnc-empty');
    e.createEl('h3', { text: this.lane ? `Talk to the ${this.lane} strand` : `Talk to the ${this.brain().name} brain` });
    e.createEl('p', { text: this.lane ? `Your first message starts a Claude session for ${this.lane}. Other strands keep their own sessions and can work at the same time.` : 'Your first message starts the General session for this brain: messages about a node with a strand go to that strand\'s own session.' });
  }
  ingest(e) {
    const B = this.tr.blocks;
    if (e.isSidechain) return;
    if (e.type === 'summary' || (e.type === 'system' && e.subtype === 'compact_boundary')) { B.push({ k: 'note', text: 'Context compacted: Claude summarized the earlier conversation.' }); return; }
    const m = e.message;
    if (!m) return;
    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary) return;
      const c = m.content;
      if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) {
        for (const x of c) if (x.type === 'tool_result') { const t = this.tr.tools.get(x.tool_use_id); if (t) { t.result = resultText(x.content); t.error = !!x.is_error; t.dirty = true; } }
        return;
      }
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text' && !/^<(system-reminder|command-|local-command)/.test(x.text)).map((x) => x.text).join('\n') : '';
      if (!text.trim() || /^<(command-|local-command)/.test(text)) return;
      const ow = ownerWords(text);
      B.push({ k: 'user', text: ow ? ow.text : text, about: ow && ow.about, map: !!ow, t: e.timestamp });
    } else if (e.type === 'assistant') {
      for (const x of m.content || []) {
        if (x.type === 'text' && x.text.trim()) B.push({ k: 'say', text: x.text, t: e.timestamp });
        else if (x.type === 'tool_use') { const t = { k: 'tool', id: x.id, name: x.name, input: x.input, t: e.timestamp }; this.tr.tools.set(x.id, t); B.push(t); }
      }
    }
  }
  renderBlocks() {
    const B = this.tr.blocks;
    if (this.tr.emptyShown) { this.col.empty(); this.tr.emptyShown = false; }
    for (let i = this.tr.rendered; i < B.length; i++) {
      const b = B[i];
      if (b.k === 'user') {
        if (this.tr.turn) this.settleTurn(this.tr.turn);
        this.tr.turn = null;
        const prevSay = this.lastTurnEnd(i);
        if (prevSay) this.usageFooter(prevSay.el, prevSay.t);
        const u = this.col.createDiv('bnc-user');
        if (b.about) u.createDiv({ cls: 'bnc-from', text: 'About ' + b.about });
        u.createDiv({ cls: 'bnc-bubble', text: b.text });
      } else if (b.k === 'say') {
        const el = b.el = this.col.createDiv('bnc-say markdown-rendered');
        if (this.tr.live) this.enter(el);
        MarkdownRenderer.render(this.app, b.text, el, this.brain() ? this.brain().file : '', this).then(() => this.linkify(el));
        el.onclick = (ev) => this.linkClick(ev);
      } else if (b.k === 'tool') {
        const el = b.el = this.col.createEl('details', { cls: 'bnc-tool' });
        const s = el.createEl('summary');
        s.createSpan({ cls: 'bnc-tool-dot' });
        s.createSpan({ cls: 'bnc-tool-name', text: b.name });
        const arg = s.createSpan({ cls: 'bnc-tool-arg', text: toolSummary(b.input) });
        const fp = b.input && (b.input.file_path || b.input.notebook_path);
        if (fp) {
          const r = this.resolveRef(fp);
          if (r && !r.missing) {
            arg.addClass('bnc-ref'); arg.setAttr('aria-label', 'Open ' + (r.file ? r.file.path : fp) + ' at the place this touched. Double-click: its own app');
            this.bindRef(arg, r, b.input);
          }
        }
        b.out = el.createEl('pre', { cls: 'bnc-tool-out', text: 'Running…' });
        b.dirty = true;
      } else if (b.k === 'note') this.col.createDiv({ cls: 'bnc-divider', text: b.text });
      if (b.k === 'say' || b.k === 'tool') (this.tr.turn = this.tr.turn || { blocks: [] }).blocks.push(b);
    }
    this.tr.rendered = B.length;
    for (const t of this.tr.tools.values()) if (t.dirty && t.el) {
      t.dirty = false;
      t.el.toggleClass('is-done', t.result != null); t.el.toggleClass('is-error', !!t.error);
      t.out.setText(t.result == null ? 'Running…' : (t.result.length > 6000 ? t.result.slice(0, 6000) + '\n…' : t.result) || '(no output)');
    }
    if (this.tr.turn) this.settleTurn(this.tr.turn);
    this.footers();
  }
  /* A turn's working steps (tool calls and the narration between them) fold into one line; the answer that ends
     the turn stays in full below it. The line says how many steps, which files changed and how many failed,
     and while Claude works, its latest words. A step or narration that a later step follows moves into the fold. */
  settleTurn(T) {
    const bs = T.blocks;
    let last = -1;
    bs.forEach((b, i) => { if (b.k === 'tool') last = i; });
    if (last < 0) return;
    if (!T.el) {
      T.el = createEl('details', { cls: 'bnc-work' });
      T.sum = T.el.createEl('summary'); T.body = T.el.createDiv('bnc-work-body');
      bs[0].el.before(T.el);
      if (this.tr.live) this.enter(T.el);
      T.el.addEventListener('toggle', () => {
        if (T.el.open && !calm()) T.body.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
      });
    }
    for (let i = 0; i <= last; i++) { if (bs[i].el.parentElement !== T.body) T.body.append(bs[i].el); if (bs[i].k === 'say') bs[i].el.addClass('is-aside'); }
    let at = T.el;
    for (let i = last + 1; i < bs.length; i++) { const el = bs[i].el; el.removeClass('is-aside'); if (at.nextElementSibling !== el) at.after(el); at = el; }
    const tools = bs.filter((b, i) => i <= last && b.k === 'tool'), working = tools.some((t) => t.result == null);
    const failed = tools.filter((t) => t.error).length;
    const changed = [...new Set(tools.filter((t) => /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t.name)).map((t) => t.input && (t.input.file_path || t.input.notebook_path)).filter(Boolean))];
    const said = working ? bs.slice(0, last + 1).filter((b) => b.k === 'say').pop() : null;
    const sig = [tools.length, working, failed, changed.join('|'), said ? said.text : ''].join('§');
    if (sig === T.sig) return;
    T.sig = sig;
    const s = T.sum; s.empty();
    setIcon(s.createSpan({ cls: 'bnc-work-ic' }), 'chevron-right');
    s.createSpan({ cls: 'bnc-work-n', text: (working ? 'Working · ' : '') + tools.length + (tools.length === 1 ? ' step' : ' steps') });
    if (changed.length) {
      s.createSpan({ text: ' · changed ' });
      changed.slice(0, 3).forEach((fp, i) => {
        if (i) s.createSpan({ text: ', ' });
        const a = s.createSpan({ cls: 'bnc-work-file', text: String(fp).split(/[\\/]/).pop() });
        const r = this.resolveRef(fp);
        if (r && !r.missing) { a.addClass('bnc-ref'); a.setAttr('aria-label', 'Open ' + (r.file ? r.file.path : fp)); this.bindRef(a, r); }
      });
      if (changed.length > 3) s.createSpan({ text: ` +${changed.length - 3}` });
    }
    if (failed) s.createSpan({ cls: 'bnc-work-fail', text: ` · ${failed} failed` });
    if (said) s.createSpan({ cls: 'bnc-work-now', text: said.text.replace(/\s+/g, ' ').slice(0, 160) });
  }
  /* a usage line under each answer that ends a turn; the last one appears once its run is recorded as finished */
  footers() {
    const B = this.tr.blocks;
    for (let i = 0; i < B.length; i++) {
      if (B[i].k !== 'say') continue;
      const next = B.slice(i + 1).find((x) => x.k === 'say' || x.k === 'user');
      if (!next || next.k === 'user') this.usageFooter(B[i].el, B[i].t);
    }
  }
  lastTurnEnd(i) { for (let j = i - 1; j >= 0; j--) { const b = this.tr.blocks[j]; if (b.k === 'user') return null; if (b.k === 'say') return b; } return null; }
  /* the tokens and cost of the map message that produced this answer, matched by time */
  usageFooter(el, t) {
    if (!el || el.nextElementSibling && el.nextElementSibling.hasClass('bnc-usage')) return;
    const ts = Date.parse(t);
    const sid = this.sid(), run = this.plugin.runsFor(this.brainId).find((r) => (r.session === sid || r.resumed === sid) && r.start && r.end && ts >= r.start - 2000 && ts <= r.end + 2000);
    if (!run || !run.usage) return;
    const u = run.usage, d = createDiv({ cls: 'bnc-usage' });
    const say = this.tr.blocks.find((x) => x.el === el);
    if (say) { const c = d.createEl('button', { cls: 'bnc-copy', text: 'Copy' }); c.onclick = () => this.plugin.copy(this.turnText(say), 'Answer copied.'); d.createSpan({ text: ' · ' }); }
    d.setText([run.modelId || run.model, run.effort ? run.effort + ' effort' : null, `${kfmt(u.in + u.cacheRead + u.cacheWrite)} in (${kfmt(u.cacheRead)} cached)`, `${kfmt(u.out)} out`, usd(run.cost), run.end && run.start ? Math.round((run.end - run.start) / 1000) + ' s' : null].filter(Boolean).join(' · '));
    el.after(d);
  }
  /* queued messages and the working indicator live below the transcript */
  renderTail() {
    if (!this.tail || !this.brain()) return;
    const P = this.plugin, runs = P.runsFor(this.brainId, this.lane);
    const queued = runs.filter((r) => r.status === 'queued').reverse(), running = runs.find((r) => r.status === 'running');
    const failed = runs.find((r) => r.status === 'failed' && r.end && Date.now() - r.end < 10 * 60000 && !this.viewing);
    const echoed = running && this.tr.blocks.some((b) => b.k === 'user' && Date.parse(b.t) >= running.start - 2000);
    const sig = queued.map((r) => r.id).join(',') + '|' + (running ? running.id + running.steps.length : '') + '|' + (echoed ? 'e' : '') + '|' + (failed ? failed.id : '');
    if (sig === this._tailSig && !(running && Date.now() - (this._tailAt || 0) > 1000)) return;
    this._tailSig = sig; this._tailAt = Date.now();
    this.tail.empty();
    if (running && !echoed) {
      const u = this.tail.createDiv('bnc-user');
      u.createDiv({ cls: 'bnc-bubble', text: running.text });
      this.enterOnce(u, running.id);
    }
    if (running) {
      const w = this.tail.createDiv('bnc-working');
      w.createSpan({ cls: 'bnc-spin' });
      const last = running.steps.filter((s) => s.k === 'tool').slice(-1)[0];
      w.createSpan({ text: `Claude is working · ${Math.round((Date.now() - running.start) / 1000)} s` + (last ? ` · ${last.name} ${last.text}` : '') });
    }
    for (const q of queued) {
      const u = this.tail.createDiv('bnc-user is-queued');
      this.enterOnce(u, q.id);
      u.createDiv({ cls: 'bnc-from', text: 'Queued: sends when the message before it finishes' });
      u.createDiv({ cls: 'bnc-bubble', text: q.text });
      const c = u.createEl('button', { cls: 'bn-linkbtn', text: 'Cancel' }); c.onclick = () => P.stopRun(q);
    }
    if (failed) {
      const e = this.tail.createDiv('bnc-failed');
      e.createDiv({ text: 'The last message did not complete: ' + (failed.error || failed.result || failed.terminal || 'unknown error') });
      if (failed.denials && failed.denials.length) e.createDiv({ text: 'Refused by permissions: ' + failed.denials.join(' · ') });
    }
  }
  /* the tail is redrawn every second while Claude works; a message eases in only the first time it appears */
  enterOnce(el, key) {
    const seen = this._seen || (this._seen = new Set());
    if (seen.has(key)) return;
    seen.add(key); this.enter(el);
  }
  enter(el) {
    if (calm()) return;
    el.addClass('bn-enter');
    el.addEventListener('animationend', () => el.removeClass('bn-enter'), { once: true });
  }
  resolveRef(raw, ctx) { return this.refs.resolveRef(raw, ctx); }
  linkify(el) { return this.refs.linkify(el); }
  bindRef(el, r, toolInput) { return this.refs.bindRef(el, r, toolInput); }
  linkClick(ev) { return this.refs.linkClick(ev); }
  /* an answer and the text blocks around it in the same turn, as Markdown */
  turnText(say) {
    const B = this.tr.blocks, i = B.indexOf(say), out = [];
    for (let j = i; j >= 0 && B[j].k !== 'user'; j--) if (B[j].k === 'say') out.unshift(B[j].text);
    return out.join('\n\n');
  }
  runsChanged() { if (!this.contentEl.isShown()) return; this.renderHead(); this.renderTail(); this.footers(); this.renderControls(); }
}

/* ------------------------------------------------------------- file tab */
/* Shows any file or folder on disk in an Obsidian tab, including ones outside the vault: images, video and audio play
   in place, folders are a grid you can walk, text files are shown as text. Double-click anything for its own app. */
const FILEVIEW = 'brain-network-file';
const TEXT_RE = /\.(txt|md|json|jsonl|csv|tsv|log|eml|cs|py|js|ts|shader|hlsl|glsl|compute|cginc|yaml|yml|xml|ini|cfg|toml|gd|tscn|tres|uss|uxml|bat|ps1|sh)$/i;
const AUDIO_RE = /\.(wav|mp3|ogg|flac|m4a)$/i;
const winPath = (p) => p.replace(/\//g, '\\');
function openWithApp(abs) {
  require('electron').shell.openPath(process.platform === 'win32' ? winPath(abs) : abs).then((err) => { if (err) new Notice('Could not open ' + abs + ': ' + err); });
}

class FileTabView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.path = null; }
  getViewType() { return FILEVIEW; }
  getDisplayText() { return this.path ? this.path.replace(/\/+$/, '').split('/').pop() : 'File'; }
  getIcon() {
    const p = this.path || '';
    return IMG_RE.test(p) ? 'image' : VID_RE.test(p) ? 'film' : AUDIO_RE.test(p) ? 'music' : TEXT_RE.test(p) ? 'file-text' : /\/$/.test(p) || !/\.[a-z0-9]+$/i.test(p) ? 'folder' : 'file';
  }
  getState() { return { path: this.path }; }
  async setState(st, res) { if (st && st.path) { this.path = st.path; this.render(); } return super.setState(st, res); }
  async onOpen() { this.contentEl.addClass('bnf-root'); this.render(); }
  go(p) { this.path = p; this.render(); }
  render() {
    const el = this.contentEl, p = this.path;
    el.empty();
    if (!p) return;
    const abs = p.replace(/\/+$/, '');
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { /* missing */ }
    if (st && st.isDirectory() && !p.endsWith('/')) this.path = abs + '/';
    this.leaf.updateHeader && this.leaf.updateHeader();
    const head = el.createDiv('bnf-head');
    const parent = abs.split('/').slice(0, -1).join('/');
    if (parent.includes('/')) { const up = head.createEl('button', { cls: 'bnc-icon', attr: { 'aria-label': 'Up to ' + parent } }); setIcon(up, 'arrow-up'); up.onclick = () => this.go(parent + '/'); }
    head.createEl('code', { cls: 'bnf-path', text: abs });
    head.createDiv('bn-spacer');
    const btn = (icon, label, fn) => { const x = head.createEl('button', { cls: 'bnc-icon', attr: { 'aria-label': label } }); setIcon(x, icon); x.onclick = fn; };
    btn('copy', 'Copy path', () => this.plugin.copy(winPath(abs), 'Path copied.'));
    btn('folder-open', 'Show in File Explorer', () => require('electron').shell.showItemInFolder(winPath(abs)));
    btn('external-link', 'Open with its own app', () => openWithApp(abs));
    const body = el.createDiv('bnf-body');
    if (!st) { body.createDiv({ cls: 'bnf-missing', text: 'Not found on disk. It may have been moved or deleted.' }); return; }
    const src = this.plugin.externalSrc(abs);
    if (st.isDirectory()) return this.folder(body, abs);
    if (IMG_RE.test(abs)) {
      const img = body.createEl('img', { cls: 'bnf-img', attr: { src, alt: abs.split('/').pop() } });
      img.onclick = () => img.toggleClass('is-actual', !img.hasClass('is-actual'));
    } else if (VID_RE.test(abs)) {
      body.createEl('video', { cls: 'bnf-video', attr: { src, controls: '', autoplay: '', loop: '' } });
    } else if (AUDIO_RE.test(abs)) {
      body.createEl('audio', { attr: { src, controls: '' } });
    } else if (TEXT_RE.test(abs) && st.size < 2e6) {
      const t = fs.readFileSync(abs, 'utf8');
      body.createEl('pre', { cls: 'bnf-text', text: t.length > 300000 ? t.slice(0, 300000) + '\n…' : t });
    } else {
      body.createDiv({ cls: 'bnf-missing', text: `${(st.size / 1024).toFixed(0)} KB · Obsidian cannot show this kind of file. Double-click a link to it, or use the button above, to open it in its own app.` });
    }
  }
  folder(body, abs) {
    let names = [];
    try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { body.createDiv({ cls: 'bnf-missing', text: 'Cannot read this folder: ' + e.message }); return; }
    names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    body.createDiv({ cls: 'bnf-count', text: `${names.length} item${names.length === 1 ? '' : 's'} · click to open here, double-click for its own app` });
    const grid = body.createDiv('bnf-grid');
    for (const d of names.slice(0, 600)) {
      const full = abs + '/' + d.name, tile = grid.createDiv('bnf-tile');
      const th = tile.createDiv('bnf-thumb');
      if (!d.isDirectory() && IMG_RE.test(d.name)) th.createEl('img', { attr: { src: this.plugin.externalSrc(full), loading: 'lazy', alt: '' } });
      else setIcon(th, d.isDirectory() ? 'folder' : VID_RE.test(d.name) ? 'film' : AUDIO_RE.test(d.name) ? 'music' : TEXT_RE.test(d.name) ? 'file-text' : 'file');
      tile.createDiv({ cls: 'bnf-name', text: d.name });
      let tm = null;
      tile.onclick = () => { if (tm) return; tm = setTimeout(() => { tm = null; this.go(d.isDirectory() ? full + '/' : full); }, 260); };
      tile.ondblclick = () => { clearTimeout(tm); tm = null; openWithApp(full); };
    }
    if (names.length > 600) body.createDiv({ cls: 'bnf-count', text: `${names.length - 600} more not shown.` });
  }
}

class BrainSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, D = this.plugin.settings.dispatch, save = () => this.plugin.saveSettings();
    el.empty();
    const S = this.plugin.settings;
    el.createEl('h3', { text: 'Map' });
    new Setting(el).setName('Sounds').setDesc('A soft chime when a node appears, when something needs you, and when a Claude run finishes.')
      .addToggle((t) => t.setValue(S.sounds).onChange((v) => { S.sounds = v; save(); }))
      .addSlider((sl) => sl.setLimits(0, 1, 0.05).setValue(S.volume == null ? 0.35 : S.volume).setDynamicTooltip().onChange((v) => { S.volume = v; save(); }))
      .addButton((b) => b.setButtonText('Test').onClick(() => { this.plugin._chimeAt = 0; this.plugin.chime('new'); }));
    new Setting(el).setName('Open the Chat when you select a node').setDesc('The Card shows beside every selected node either way. Ctrl+Space shows or hides the Chat at any time (change the key under Hotkeys: "Brain Network: Show or hide the Chat").')
      .addToggle((t) => t.setValue(!!S.chatOnSelect).onChange((v) => { S.chatOnSelect = v; save(); }));
    el.createEl('h3', { text: 'Claude dispatch' });
    el.createEl('p', { cls: 'setting-item-description', text: 'Messages from the map run Claude Code\'s CLI in print mode, one resumable session per brain. The CLI needs its own login: run claude in a terminal once, then /login.' });
    new Setting(el).setName('Send messages to Claude').setDesc('Off: replies are only written to the notes, and Claude sees them on your next prompt.').addToggle((t) => t.setValue(D.on).onChange((v) => { D.on = v; save(); }));
    new Setting(el).setName('Claude CLI path').setDesc('Empty: ' + this.plugin.cliPath()).addText((t) => t.setPlaceholder('auto').setValue(D.cli).onChange((v) => { D.cli = v.trim(); save(); }));
    new Setting(el).setName('Default model').setDesc('Each brain can override it in its session panel.').addDropdown((d) => { MODELS.forEach(([v, l]) => d.addOption(v, l)); d.setValue(D.model || '').onChange((v) => { D.model = v; save(); }); });
    new Setting(el).setName('Default effort').setDesc('How hard Claude thinks per message; each brain can override it.').addDropdown((d) => { EFFORTS.forEach(([v, l]) => d.addOption(v, l)); d.setValue(D.effort || '').onChange((v) => { D.effort = v; save(); }); });
    new Setting(el).setName('Default permissions').addDropdown((d) => { MODES.forEach(([v, l]) => d.addOption(v, l)); d.setValue(D.mode).onChange((v) => { D.mode = v; save(); }); });
    new Setting(el).setName('Start a fresh session after').setDesc("When a strand's Claude session passes this much context, its next message starts a new session; the old one stays readable. Long sessions give weaker, dearer answers.")
      .addDropdown((d) => { FRESH.forEach(([v, l]) => d.addOption(String(v), l)); d.setValue(String(D.freshAt || 0)).onChange((v) => { D.freshAt = Number(v); save(); }); });
    new Setting(el).setName('Spending cap per run (USD)').setDesc('Passed as --max-budget-usd; a run stops when it would exceed it.').addText((t) => t.setValue(String(D.budget)).onChange((v) => { const n = parseFloat(v); if (n > 0) { D.budget = n; save(); } }));
  }
}

module.exports = class BrainNetwork extends Plugin {
  async onload() {
    this.settings = Object.assign({ pins: { top: {}, strand: {} }, inboxOpen: true, lastBrain: null, drawerOpen: false, dockW: 440, chatOnSelect: false, sounds: true, volume: 0.35 }, await this.loadData());
    this.settings.dispatch = Object.assign({ on: true, cli: '', model: '', effort: '', mode: 'bypassPermissions', budget: 2, freshAt: 150000, brains: {} }, this.settings.dispatch || {});
    this.procs = new Map();
    this.loadRuns();
    this.addSettingTab(new BrainSettings(this.app, this));
    this.settings.pins.strand = {}; /* strands arrange themselves now; old drags no longer apply */
    this.live = { brains: new Map(), files: new Map() };
    this.replies = new Map(); this.touched = new Map();
    this.layoutCache = new Map();
    this.registerView(VIEW, (leaf) => new BrainView(leaf, this));
    this.registerView(CHAT, (leaf) => new ChatView(leaf, this));
    this.registerView(FILEVIEW, (leaf) => new FileTabView(leaf, this));
    this.addRibbonIcon('brain-circuit', 'Open Brain Network', () => this.activate());
    this.status = this.addStatusBarItem();
    this.status.addClass('bn-status');
    this.status.onclick = () => this.activate(true);
    this.addCommand({ id: 'open', name: 'Open the map', callback: () => this.activate() });
    this.addCommand({ id: 'inbox', name: 'Show what is waiting on me', callback: () => this.activate(true) });
    const withView = (fn) => async () => { await this.activate(); const v = this.views()[0]; if (v) fn(v); };
    this.addCommand({ id: 'toggle-last-brain', name: 'Switch between all brains and the last brain', callback: withView((v) => v.toggleLast()) });
    this.addCommand({ id: 'next-waiting', name: 'Go to the next item waiting on me', callback: withView((v) => v.stepWaiting(1)) });
    this.addCommand({ id: 'prev-waiting', name: 'Go to the previous item waiting on me', callback: withView((v) => v.stepWaiting(-1)) });
    this.addCommand({ id: 'toggle-drawer', name: 'Show or hide the Chat', hotkeys: [{ modifiers: ['Mod'], key: ' ' }], callback: withView((v) => v.toggleDrawer()) });
    this.addCommand({ id: 'copy-claude-queue', name: "Copy Claude's queue as a prompt", callback: () => this.copy(this.queuePrompt(this.model.items.filter((i) => i.state === 'claude')), 'Prompt copied.') });
    this.addCommand({
      id: 'make-brain', name: 'Make the current note a brain front page',
      checkCallback: (check) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        if (!check) new NameModal(this.app, f.parent && f.parent.path !== '/' ? f.parent.name : f.basename, (name) => this.app.fileManager.processFrontMatter(f, (fm) => { fm.brain = name; })).open();
        return true;
      },
    });
    const soon = () => { clearTimeout(this.tm); this.tm = setTimeout(() => this.rebuild(), 350); };
    this.registerEvent(this.app.metadataCache.on('changed', soon));
    this.registerEvent(this.app.metadataCache.on('resolved', soon));
    this.registerEvent(this.app.vault.on('delete', soon));
    this.registerEvent(this.app.vault.on('rename', soon));
    this.app.workspace.onLayoutReady(() => {
      this.rebuild(); this.readLive();
      /* the chat used to be its own tab; it lives in the map's drawer now */
      this.app.workspace.getLeavesOfType(CHAT).forEach((l) => l.detach());
    });
    this.registerInterval(window.setInterval(() => this.readLive(), 5000));
    this.registerDomEvent(window, 'focus', () => this.readLive());
  }
  onunload() {
    for (const r of this.runs || []) if (r.status === 'running') this.stopRun(r);
  }
  async saveSettings() { await this.saveData(this.settings); }
  get dir() { return nodePath.join(this.app.vault.adapter.getBasePath(), this.manifest.dir); }

  rebuild() {
    const prev = this.model;
    this.model = buildModel(this.app);
    if (prev) this.noticeChanges(prev);
    this.layoutCache.clear();
    const n = this.model.items.filter((i) => i.state === 'owner').length;
    this.updateStatus();
    this.writeStatus();
    this.readLive(true);
    this.views().forEach((v) => v.refresh(false));
  }
  /* new nodes and nodes that changed hands: remembered until you select them (or six hours), announced with a sound */
  noticeChanges(prev) {
    this.fresh = this.fresh || new Map();
    const wasBad = new Set((prev.broken || []).map((x) => x.path));
    for (const x of this.model.broken || []) {
      const lost = prev.items.filter((i) => i.file === x.path).length;
      if (wasBad.has(x.path) || !lost) continue;
      this.chime('fail');
      new Notice(createFragment((fr) => {
        fr.createSpan({ text: `${x.path.split('/').pop()} stopped parsing${lost ? `: its ${lost} items are hidden on the map` : ''}. ` });
        const btn = fr.createEl('button', { text: 'Open note', cls: 'bn-notice-btn' });
        btn.onclick = () => this.app.workspace.openLinkText(x.path, '', 'tab');
      }), 15000);
    }
    const now = Date.now(), added = [], moved = [], mine = this.lastAction && now - (this.lastAction.t || 0) < 15000 ? this.lastAction.item : null;
    for (const it of this.model.items) {
      const o = prev.byItem.get(it.id);
      if (!o) { added.push(it); this.fresh.set(it.id, { t: now, kind: 'new', to: it.state }); }
      else if (o.state !== it.state && it.id !== mine) { moved.push(it); this.fresh.set(it.id, { t: now, kind: 'state', from: o.state, to: it.state }); }
    }
    for (const [id, f] of this.fresh) if (!this.model.byItem.has(id) || now - f.t > 6 * 3600e3) this.fresh.delete(id);
    if (added.length > 12) { added.forEach((i) => this.fresh.delete(i.id)); return; }
    if (!added.length && !moved.length) return;
    this.chime(added.length ? 'new' : moved.some((i) => i.state === 'owner') ? 'owner' : 'state');
    const say = (it, what) => new Notice(createFragment((f) => {
      f.createSpan({ text: `${what} · ${this.model.byBrain.get(it.brain).name}: ${it.title}` });
      const b = f.createEl('button', { text: 'Show', cls: 'bn-notice-btn' });
      b.onclick = () => this.activate().then(() => { const v = this.views()[0]; if (v) v.focusItem(it.id); });
    }), 9000);
    added.slice(0, 3).forEach((it) => say(it, 'New node, ' + (it.state === 'codex' ? 'waiting for Codex' : STATE[it.state].label.toLowerCase())));
    moved.filter((i) => i.state === 'owner').slice(0, 3).forEach((it) => say(it, 'Needs you'));
  }
  /* soft sine notes, no sound files: two rising for a new node, three for something that needs you, two for a finished run */
  chime(kind) {
    if (!this.settings.sounds) return;
    const now = Date.now();
    if (now - (this._chimeAt || 0) < 1200) return;
    this._chimeAt = now;
    try {
      const A = this._ac || (this._ac = new (window.AudioContext || window.webkitAudioContext)());
      if (A.state === 'suspended') A.resume();
      const notes = { new: [659.25, 987.77], owner: [523.25, 659.25, 783.99], done: [783.99, 1046.5], state: [587.33], fail: [392, 329.63] }[kind] || [660];
      const vol = Math.max(0, Math.min(1, this.settings.volume == null ? 0.35 : this.settings.volume)) * 0.2;
      notes.forEach((hz, i) => {
        const t0 = A.currentTime + i * 0.12, o = A.createOscillator(), g = A.createGain();
        o.type = 'sine'; o.frequency.value = hz;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.95);
        o.connect(g); g.connect(A.destination); o.start(t0); o.stop(t0 + 1);
      });
    } catch (e) { /* no audio device */ }
  }
  /* who is working on an item right now: a Claude run from the map, a Claude edit in the last two minutes, or a Codex session */
  isRunning(it) {
    if (this.runs.some((r) => r.status === 'running' && (r.item === it.id || (r.file && !it.plan && r.file === it.file)))) return 'claude';
    if (this.codexLive && this.codexLive.has(it.id)) return 'codex';
    const t = this.live.files.get(it.file);
    if (t && !it.plan && Date.now() - t < 120000) return 'claude';
    return null;
  }
  views() { return this.app.workspace.getLeavesOfType(VIEW).map((l) => l.view).filter((v) => v instanceof BrainView); }
  async activate(inbox) {
    if (inbox) { this.settings.inboxOpen = true; this.saveSettings(); }
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW, active: true }); }
    this.app.workspace.revealLeaf(leaf);
    if (inbox && leaf.view instanceof BrainView) { leaf.view.renderBar(); leaf.view.renderInbox(); }
  }

  /* ---------- layout with pins ---------- */
  topLayout() {
    const key = 'top|' + this.model.brains.map((b) => b.id + ':' + b.parents.join(',') + ':' + b.level).join('|');
    if (!this.layoutCache.has(key)) this.layoutCache.set(key, layoutTop(this.model.brains));
    const pos = JSON.parse(JSON.stringify(this.layoutCache.get(key)));
    for (const [id, p] of Object.entries(this.settings.pins.top || {})) if (pos[id]) Object.assign(pos[id], p);
    return pos;
  }
  strandLayout(b) {
    const key = 'strand|' + b.id + '|' + b.items.map((i) => i.id + ':' + i.title + ':' + i.date + ':' + i.stream + ':' + i.after.join(',') + ':' + i.state).join('|') + '|' + new Date().toDateString();
    if (!this.layoutCache.has(key)) this.layoutCache.set(key, layoutStrand(b, b.items, this.chipSizes(b.items)));
    return JSON.parse(JSON.stringify(this.layoutCache.get(key)));
  }
  /* chip sizes come from the real title widths in the interface font */
  chipSizes(items) {
    const c = this._mctx || (this._mctx = document.createElement('canvas').getContext('2d'));
    c.font = `600 ${CHIP_FONT}px ${fontFamily(getComputedStyle(document.body).getPropertyValue('--font-interface'), '"Segoe UI", system-ui, sans-serif')}`;
    const out = new Map();
    for (const it of items) {
      const lines = wrapText(c, it.title, CHIP_TEXT_W, 2);
      const w = Math.max(...lines.map((l) => c.measureText(l).width));
      out.set(it.id, { w: Math.round(Math.min(CHIP_TEXT_W, w) + 38), h: 14 + lines.length * CHIP_LH, lines });
    }
    return out;
  }
  setPin(brainId, id, x, y) {
    const P = this.settings.pins;
    if (!brainId) P.top[id] = { x, y };
    else { (P.strand[brainId] = P.strand[brainId] || {})[id] = { x, y }; }
    this.saveSettings();
  }
  resetPins() {
    this.settings.pins.top = {};
    this.saveSettings();
  }

  /* ---------- reading ---------- */
  async tasks(b) {
    const f = this.app.vault.getAbstractFileByPath(b.file);
    if (!f) return [];
    const text = await this.app.vault.cachedRead(f);
    return text.split(/\r?\n/).filter((l) => /^\s*[-*] \[ \]/.test(l)).map((l) => l.replace(/^\s*[-*] \[ \]\s*/, '').replace(/\*\*/g, '').replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (m, a, b, c) => c || a));
  }
  resourcePrefix() {
    if (this._prefix != null) return this._prefix;
    const ad = this.app.vault.adapter, base = ad.getBasePath().replace(/\\/g, '/');
    const probe = ad.getResourcePath('bn-probe');
    let i = probe.indexOf(encodeURI(base));
    if (i < 0) i = probe.indexOf(base);
    this._prefix = i >= 0 ? probe.slice(0, i) : 'app://local/';
    return this._prefix;
  }
  externalSrc(abs) { return this.resourcePrefix() + encodeURI(abs.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F'); }
  mediaEntry(raw, sourcePath) {
    raw = String(raw).trim().replace(/^<|>$/g, '');
    let abs = null, src = null, exists = false;
    if (/^file:\/\//i.test(raw)) {
      try { abs = decodeURI(raw.replace(/^file:\/\/\/?/i, '')); } catch (e) { abs = raw.replace(/^file:\/\/\/?/i, ''); }
    } else if (/^[a-z]:[\\/]/i.test(raw)) abs = raw;
    if (abs) { exists = fs.existsSync(abs); src = this.externalSrc(abs); }
    else {
      const f = this.app.metadataCache.getFirstLinkpathDest(linkTarget(raw), sourcePath) || this.app.vault.getAbstractFileByPath(raw);
      if (f && f.extension) { exists = true; src = this.app.vault.getResourcePath(f); abs = nodePath.join(this.app.vault.adapter.getBasePath(), f.path); }
    }
    const name = (abs || raw).split(/[\\/]/).pop();
    const kind = IMG_RE.test(name) ? 'img' : VID_RE.test(name) ? 'vid' : null;
    return kind ? { raw, abs, src, exists, name, kind } : null;
  }
  /* Review images: brain-review first; otherwise every image or clip linked in the note's Result section */
  async media(it) {
    const key = it.id + '|' + it.review.join('|');
    this._media = this._media || new Map();
    if (this._media.has(key)) return this._media.get(key);
    const out = [];
    const add = (raw) => { const e = this.mediaEntry(raw, it.file); if (e && !out.some((o) => o.abs === e.abs)) out.push(e); };
    it.review.forEach(add);
    if (!out.length && !it.plan) {
      const f = this.app.vault.getAbstractFileByPath(it.file);
      if (f) {
        let text = await this.app.vault.cachedRead(f);
        const r = text.search(/^#{1,3} Result/m);
        if (r >= 0) text = text.slice(r);
        const found = [];
        for (const m of text.matchAll(/\]\((file:\/\/\/[^)\s]+)\)/gi)) found.push(m[1]);
        for (const m of text.matchAll(/!\[\[([^\]|]+)/g)) found.push(m[1]);
        for (const m of text.matchAll(/`([A-Za-z]:[\\/][^`]+?\.(?:png|jpe?g|webp|gif|mp4|webm|mov))`/gi)) found.push(m[1]);
        const score = (s) => (/review|sheet|grid|compare|contact/i.test(s) ? 0 : 1) + (/oklab|-l\.|gray/i.test(s) ? 1 : 0);
        found.sort((a, b) => score(a) - score(b)).forEach(add);
      }
    }
    this._media.set(key, out);
    setTimeout(() => this._media && this._media.delete(key), 60000);
    return out;
  }
  openNote(path, heading) {
    this.app.workspace.openLinkText(path + (heading ? '#' + heading : ''), '', 'tab');
  }
  openExternal(x) {
    try { require('electron').shell.openPath(x.abs); } catch (e) { new Notice('Could not open ' + x.abs); }
  }
  async copy(text, msg) {
    try { await navigator.clipboard.writeText(text); new Notice(msg); } catch (e) { new Notice('Copy failed: ' + e.message); }
  }
  promptFor(it) {
    const b = this.model.byBrain.get(it.brain);
    if (it.state === 'claude') return `In the ${b.name} brain, verify "${it.file}": check its Result against the brief's acceptance criteria and evidence. Then update its frontmatter: brain-state: owner with brain-ask and brain-review (the 1 to 4 images that matter, best first) if I need to judge it, or brain-state: done if nothing is left for me.`;
    if (it.state === 'codex') return `Run the queued brief "${it.file}" with Codex as the ${b.name} collaboration note describes. When Codex finishes, set brain-state: claude so the verification shows up in Brain Network.`;
    if (it.state === 'planned') return `In the ${b.name} brain, draft a brief for "${it.title}"${it.ask ? ' (' + it.ask + ')' : ''}. Link it from the brain-plan entry in "${it.file}" and give the brief brain-state: codex when it is ready to run.`;
    return null;
  }
  replyPrompt(it) {
    const b = this.model.byBrain.get(it.brain);
    return `In the ${b.name} brain, act on my reply to "${it.file}"${it.plan ? ` (the brain-plan entry "${it.title}")` : ''}. Read the newest line under "## Owner review", work out what I mean, and do it. Then set brain-state and status to match: done if nothing is left, owner with a new brain-ask if you need me again, or codex with a brief. Record any decision in the brain's Decision Log.`;
  }
  queuePrompt(items) {
    const lines = items.map((i, n) => `${n + 1}. ${this.model.byBrain.get(i.brain).name}: "${i.file}"${i.gate ? ` (then my ${(GATE[i.gate] || i.gate).toLowerCase()})` : ''}`);
    return `Verify these in order. For each, check the Result against its acceptance criteria. Then set brain-state: owner with brain-ask and brain-review (1 to 4 images, best first) if I need to judge it, or brain-state: done.\n${lines.join('\n')}`;
  }

  /* ---------- live activity: AI Trail's ledger, your replies and which Claude sessions have read them ---------- */
  readLive(quiet) {
    if (!this.model) return;
    const ledger = nodePath.join(this.app.vault.adapter.getBasePath(), '.obsidian', 'plugins', 'ai-trail', 'ledger.jsonl');
    const live = { brains: new Map(), files: new Map() }, touched = new Map();
    try {
      const st = fs.statSync(ledger), len = Math.min(st.size, 400000), buf = Buffer.alloc(len);
      const fd = fs.openSync(ledger, 'r'); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      const cut = Date.now() - LIVE_MS;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('"file":"')) continue;
        let e; try { e = JSON.parse(line); } catch (x) { continue; }
        if (!e.file || !e.t) continue;
        touched.set(e.file, Math.max(touched.get(e.file) || 0, e.t));
        if (e.t < cut) continue;
        live.files.set(e.file, Math.max(live.files.get(e.file) || 0, e.t));
        const b = this.model.ownerOf(e.file);
        if (!b) continue;
        const v = live.brains.get(b.id) || { sids: new Set(), files: new Set(), last: 0 };
        v.sids.add(e.sid); v.files.add(e.file); v.last = Math.max(v.last, e.t);
        live.brains.set(b.id, v);
      }
    } catch (e) { /* no AI Trail ledger: no live markers */ }
    this.live = live; this.touched = touched;
    /* Codex: a session log in ~/.codex/sessions/<today> written in the last 2.5 minutes that names the brief */
    const codexLive = new Map();
    try {
      const root = nodePath.join(require('os').homedir(), '.codex', 'sessions'), now = Date.now();
      const cand = this.model.items.filter((i) => !i.plan && (i.state === 'codex' || i.state === 'claude'));
      for (const off of cand.length ? [0, 1] : []) {
        const d = new Date(now - off * 864e5), dir = nodePath.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { continue; }
        for (const nm of names) {
          if (!nm.endsWith('.jsonl')) continue;
          const fp = nodePath.join(dir, nm), st = fs.statSync(fp);
          if (now - st.mtimeMs > 150000) continue;
          const len = Math.min(st.size, 600000), buf = Buffer.alloc(len), fd = fs.openSync(fp, 'r');
          fs.readSync(fd, buf, 0, len, 0); fs.closeSync(fd);
          const txt = buf.toString('utf8');
          for (const it of cand) if (txt.includes(it.file.split('/').pop().replace(/\.md$/, ''))) codexLive.set(it.id, st.mtimeMs);
        }
      }
    } catch (e) { /* no Codex sessions folder */ }
    this.codexLive = codexLive;
    const replies = new Map();
    try {
      const all = fs.readFileSync(nodePath.join(this.dir, 'replies.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (x) { return null; } }).filter(Boolean);
      let hs = {};
      try { hs = JSON.parse(fs.readFileSync(nodePath.join(this.dir, 'hook-state.json'), 'utf8')); } catch (x) { /* no session has run the hook yet */ }
      const delivered = hs.delivered || {}, undone = new Set(all.filter((e) => e.verdict === 'undo').map((e) => e.undoes));
      const now = Date.now();
      for (const e of all) {
        if (e.verdict === 'undo' || undone.has(e.t) || now - e.t > 7 * 864e5) continue;
        const it = (e.id && this.model.byItem.get(e.id)) || this.model.items.find((i) => i.file === e.file && i.title === e.item);
        if (!it) continue;
        const open = ['reply', 'back', 'note'].includes(e.verdict) && it.state === e.to && now - e.t < 3 * 864e5;
        const run = e.dispatched ? this.runs.find((r) => r.id === e.dispatched) : null;
        const seen = run ? (run.start ? { at: run.start, run: true } : null) : delivered[e.t] || null;
        replies.set(it.id, { ...e, seen, open: run ? run.status === 'queued' || run.status === 'running' || open : open, run: run || null });
      }
    } catch (e) { /* no replies yet */ }
    this.replies = replies;
    const sig = [...replies.values()].map((r) => r.t + (r.seen ? 's' : '') + (r.open ? 'o' : '')).join(',') + '|' + [...live.files.keys()].join(',') + '|' + [...this.codexLive.keys()].join(',');
    if (!quiet && sig !== this._sig) this.views().forEach((v) => v.liveChanged());
    this._sig = sig;
  }

  /* ---------- dispatch: every request goes to Claude Code's CLI in print mode, one resumable session per brain ----------
     Runs stream JSON events: system/init carries the session id, each assistant message carries its API usage (the last
     one's input + cache tokens is how full the context is), and the result carries cost, totals and refused permissions. */
  cliPath() {
    const s = (this.settings.dispatch.cli || '').trim();
    if (s) return s;
    const p = nodePath.join(require('os').homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    return fs.existsSync(p) ? p : 'claude';
  }
  brainCfg(bid) {
    const B = this.settings.dispatch.brains;
    return (B[bid] = B[bid] || { session: null, model: null, effort: null, mode: null, ctx: null });
  }
  /* One Claude session per strand: '' is the brain's General session (kept on the brain itself, as before strands had
     their own), any other key is a strand name or a side session. Strands run side by side; each keeps one queue. */
  slot(bid, lane) {
    const cfg = this.brainCfg(bid);
    if (!lane) return cfg;
    cfg.lanes = cfg.lanes || {};
    return (cfg.lanes[lane] = cfg.lanes[lane] || { session: null, past: [], ctx: null });
  }
  laneOf(itemId) { const it = itemId && this.model && this.model.byItem.get(itemId); return (it && it.stream) || ''; }
  runsFor(bid, lane) { return this.runs.filter((r) => r.brain === bid && (lane === undefined || (r.lane || '') === lane)); }
  runningIn(bid, lane) { return this.runsFor(bid, lane).some((r) => r.status === 'running' || r.status === 'queued'); }
  loadRuns() {
    this.runs = [];
    try {
      const lines = fs.readFileSync(nodePath.join(this.dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-400);
      for (const l of lines) { try { this.runs.unshift(JSON.parse(l)); } catch (e) { /* skip a torn line */ } }
    } catch (e) { /* no runs yet */ }
  }
  /* req: { brain, item?, file?, title, text, lane? } — text is the owner's own words; lane defaults to the item's strand */
  dispatch(req) {
    const b = this.model.byBrain.get(req.brain);
    if (!b) throw new Error('brain not found');
    const run = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), brain: b.id, brainName: b.name,
      item: req.item || null, file: req.file || null, title: req.title || b.name, text: req.text,
      lane: req.lane != null ? req.lane : this.laneOf(req.item),
      status: 'queued', queued: Date.now(), steps: [], usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, ctx: null,
    };
    this.runs.unshift(run);
    this.runsChanged();
    this.pump(b.id, run.lane);
    return run;
  }
  pump(bid, lane) {
    const mine = this.runsFor(bid, lane || '');
    if (mine.some((r) => r.status === 'running')) return;
    const next = mine.filter((r) => r.status === 'queued').pop();
    if (next) this.startRun(next);
  }
  /* Instructions go with a session's first message only; later messages are a one-line header and your words. */
  runPrompt(run) {
    const head = `[Brain Network · ${run.brainName}${run.lane ? ` · ${run.lane} strand` : ''}${run.file ? ` · about "${run.title}" (${run.file})` : ''}]`;
    if (run.resumed) return `${head}\n${run.text}`;
    return [head, run.text, '', '---', 'Brain Network instructions (sent once, at the start of this session):',
      `You are the ${run.brainName} brain's Claude session${run.lane ? ` for its "${run.lane}" strand` : ''}. The owner writes to you from the Brain Network map and chat in Obsidian; your final message is shown there as your reply. A header line like the one above says which item a message is about.`,
      'Other strands of this brain have their own Claude sessions, which may run at the same time. Re-read a shared note (Current State, Decision Log, Roadmap) right before you edit it, and keep to your own strand unless the owner asks otherwise.',
      ...(run.freshFrom ? [`This session replaces an earlier one that grew to ${kfmt(run.freshFrom.used)} tokens (session ${run.freshFrom.session}). The brain's notes should hold what matters; read that session's transcript only if you need something specific from it.`] : []),
      'Read the item note, including its "## Owner review" section, and whatever else you need, then do what they ask. If it is unclear, or needs the owner (art, direction, money, sending), set brain-state: owner with one question in brain-ask instead of guessing.',
      'When you change an item, update its brain-state and status in the same edit, and record decisions in the brain\'s Decision Log. If a permission is refused, stop and say exactly what you needed.',
      'Keep front matter valid YAML: add a brain-plan entry whole, between two entries, never inside one, and never repeat a key. Obsidian drops front matter that does not parse, and every item in that note disappears from the map.',
      'Point the owner to files as vault paths in backticks, relative to the vault or this brain\'s folder, with :line for a specific place (for example `Decision Log.md:42`); the chat turns them into links that open the note at that line.',
      'End each message with a short reply to the owner: what you did, what is next, and anything you could not verify.'].join('\n');
  }
  startRun(run) {
    const D = this.settings.dispatch, cfg = this.brainCfg(run.brain), slot = this.slot(run.brain, run.lane);
    /* a session past the threshold makes way for a fresh one; long contexts make answers worse and dearer */
    if (D.freshAt && slot.session && slot.ctx && slot.ctx.used > D.freshAt) {
      run.freshFrom = { session: slot.session, used: slot.ctx.used };
      slot.past = [slot.session, ...(slot.past || []).filter((x) => x !== slot.session)].slice(0, 12);
      slot.session = null; slot.ctx = null; this.saveSettings();
      new Notice(`${run.brainName}${run.lane ? ' · ' + run.lane : ''}: starting a fresh Claude session. The last one reached ${kfmt(run.freshFrom.used)} tokens and stays readable under earlier sessions.`);
    }
    run.model = cfg.model || D.model || null;
    run.mode = cfg.mode || D.mode || 'bypassPermissions';
    run.effort = cfg.effort || D.effort || null;
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', run.mode, '--max-budget-usd', String(D.budget || 2)];
    if (run.model) args.push('--model', run.model);
    if (run.effort) args.push('--effort', run.effort);
    if (slot.session) args.push('--resume', slot.session);
    run.resumed = slot.session || null;
    run.status = 'running'; run.start = Date.now();
    const base = this.app.vault.adapter.getBasePath();
    let child;
    try {
      child = require('child_process').spawn(this.cliPath(), args, { cwd: base, env: Object.assign({}, process.env, { BRAIN_NETWORK_RUN: run.id }), windowsHide: true });
    } catch (e) { this.finishRun(run, null, 'Could not start the Claude CLI: ' + e.message); return; }
    this.procs.set(run.id, child);
    let buf = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { this.onRunEvent(run, JSON.parse(line)); } catch (e) { /* not JSON: ignore */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.on('error', (e) => { run.error = e.code === 'ENOENT' ? `Claude CLI not found at ${this.cliPath()}. Set its path in Brain Network settings.` : e.message; });
    child.on('close', (code) => { this.procs.delete(run.id); this.finishRun(run, code, run.error || (code && !run.result ? err.trim().split('\n').pop() : null)); });
    child.stdin.on('error', () => {});
    child.stdin.end(this.runPrompt(run));
    this.runsChanged();
  }
  onRunEvent(run, e) {
    const slot = this.slot(run.brain, run.lane);
    if (e.type === 'system' && e.subtype === 'init') {
      run.session = e.session_id; run.modelId = e.model; run.mode = e.permissionMode || run.mode;
      slot.session = e.session_id; this.saveSettings();
    } else if (e.type === 'assistant' && e.message) {
      const m = e.message, u = m.usage;
      if (e.error) run.error = e.error === 'authentication_failed' ? 'The Claude CLI is not logged in. Open a terminal, run claude, then /login.' : e.error;
      if (u && m.model !== '<synthetic>') {
        const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        run.ctx = { used, window: run.ctx && run.ctx.window };
      }
      for (const c of m.content || []) {
        if (c.type === 'text' && c.text && c.text.trim()) run.steps.push({ k: 'say', text: c.text.trim().slice(0, 600) });
        else if (c.type === 'tool_use') run.steps.push({ k: 'tool', name: c.name, text: toolSummary(c.input) });
      }
      if (run.steps.length > 120) run.steps.splice(0, run.steps.length - 120);
    } else if (e.type === 'result') {
      run.result = e.result || ''; run.cost = e.total_cost_usd || 0; run.turns = e.num_turns; run.isError = !!e.is_error;
      run.terminal = e.terminal_reason || e.subtype; run.session = e.session_id || run.session;
      const u = e.usage || {};
      run.usage = { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
      run.denials = (e.permission_denials || []).map((d) => d.tool_name + (d.tool_input && (d.tool_input.command || d.tool_input.file_path) ? ': ' + String(d.tool_input.command || d.tool_input.file_path).slice(0, 120) : ''));
      const mu = Object.entries(e.modelUsage || {});
      if (mu.length) {
        run.models = mu.map(([k, v]) => ({ model: k, in: v.inputTokens, out: v.outputTokens, cost: v.costUSD }));
        const win = Math.max(0, ...mu.map(([, v]) => v.contextWindow || 0));
        if (win) run.ctx = { used: run.ctx ? run.ctx.used : 0, window: win };
      }
      if (e.session_id) { slot.session = e.session_id; }
    }
    this.runsChanged();
  }
  finishRun(run, code, error) {
    if (run.status === 'stopped') error = error || 'Stopped from the map.';
    run.end = Date.now();
    if (error) run.error = error;
    run.status = run.status === 'stopped' ? 'stopped' : !run.error && code === 0 && !run.isError ? 'done' : 'failed';
    if (run.isError && !run.error) run.error = run.result || run.terminal || 'The run reported an error.';
    const slot = this.slot(run.brain, run.lane);
    if (run.ctx) slot.ctx = run.ctx;
    /* a run that never reached the model (not logged in, CLI missing) must not replace the strand's session */
    const u = run.usage || {};
    if (run.status !== 'done' && !(u.in || u.out || u.cacheRead) && slot.session === run.session) slot.session = run.resumed;
    this.saveSettings();
    const keep = Object.assign({}, run);
    try { fs.appendFileSync(nodePath.join(this.dir, 'runs.jsonl'), JSON.stringify(keep) + '\n'); } catch (e) { console.error('Brain Network runs', e); }
    new Notice(run.status === 'done' ? `Claude finished: ${run.title}` : `Claude run ${run.status}: ${run.title}`);
    this.chime(run.status === 'done' ? 'done' : 'fail');
    this.runsChanged(true);
    this.pump(run.brain, run.lane || '');
  }
  stopRun(run) {
    const c = this.procs.get(run.id);
    if (run.status === 'queued') { run.status = 'stopped'; run.end = Date.now(); this.runsChanged(true); return; }
    if (c) { run.status = 'stopped'; try { c.kill(); } catch (e) { /* already gone */ } }
  }
  newSession(bid, lane) {
    const cfg = this.slot(bid, lane);
    if (cfg.session) cfg.past = [cfg.session, ...(cfg.past || []).filter((x) => x !== cfg.session)].slice(0, 12);
    cfg.session = null; cfg.ctx = null; this.saveSettings(); this.runsChanged(true);
  }
  resumeSession(bid, sid, lane) {
    const cfg = this.slot(bid, lane);
    const past = (cfg.past || []).filter((x) => x !== sid);
    if (cfg.session && cfg.session !== sid) past.unshift(cfg.session);
    cfg.past = past.slice(0, 12); cfg.session = sid; cfg.ctx = null; this.saveSettings(); this.runsChanged(true);
  }
  /* any path on disk, in a tab in the map's group */
  async openFileTab(abs) {
    const map = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (map) this.app.workspace.setActiveLeaf(map, { focus: false });
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: FILEVIEW, active: true, state: { path: abs.replace(/\\/g, '/') } });
  }
  chats() {
    return [...this.views().map((v) => v.chat), ...this.app.workspace.getLeavesOfType(CHAT).map((l) => l.view).filter((v) => v instanceof ChatView).map((v) => v.panel)].filter(Boolean);
  }
  /* the chat lives in the map's drawer: open the brain (and node), raise the drawer, put the cursor in the message box */
  async openChat(bid, about) {
    await this.activate();
    const v = this.views()[0];
    if (!v) return;
    const b = this.model.byBrain.get(bid);
    if (about && this.model.byItem.has(about)) v.focusItem(about);
    else if (b && b.items.length && !(v.mode === 'strand' && v.brainId === bid)) v.enterStrand(bid);
    else if (v.mode === 'top') v.select(bid);
    setTimeout(() => v.chatAbout(), 700);
  }
  /* opens the brain's session in a visible terminal so you can talk to it directly */
  openTerminal(bid, lane) {
    const cfg = this.slot(bid, lane), cli = this.cliPath(), base = this.app.vault.adapter.getBasePath();
    const args = cfg.session ? ['--resume', cfg.session] : [];
    try {
      if (process.platform === 'win32') require('child_process').spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', cli, ...args], { cwd: base, detached: true, stdio: 'ignore' }).unref();
      else require('child_process').spawn('open', ['-a', 'Terminal', base], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) { new Notice('Could not open a terminal: ' + e.message); }
  }
  runsChanged(now) {
    const all = () => { this.views().forEach((v) => v.runsChanged()); this.chats().forEach((v) => v.runsChanged()); this.updateStatus(); };
    if (now) { clearTimeout(this._rt); this._rt = null; all(); return; }
    if (this._rt) return;
    this._rt = setTimeout(() => { this._rt = null; all(); }, 400);
  }
  updateStatus() {
    if (!this.model) return;
    const n = this.model.items.filter((i) => i.state === 'owner').length, r = this.runs.filter((x) => x.status === 'running').length, cx = this.codexLive ? this.codexLive.size : 0;
    this.status.setText((n ? `◆ ${n} waiting on you` : '◇ nothing waiting') + (r ? ` · ⟳ ${r} Claude running` : '') + (cx ? ` · ⟳ Codex running` : ''));
    this.status.toggleClass('is-hot', n > 0);
  }

  /* ---------- writing: status snapshot for agents ---------- */
  writeStatus() {
    const m = this.model, name = (id) => m.byBrain.get(id).name;
    const out = {
      note: 'Written by the Brain Network plugin on every change. Read-only for agents; the notes are the source.',
      updated: new Date().toISOString(),
      brains: m.brains.map((b) => ({
        name: b.name, front: b.file, folder: b.folder, kind: b.kind, parents: b.parents.map(name), children: b.children.map(name),
        counts: b.counts, openChecklist: b.tasks,
        waitingOnOwner: b.items.filter((i) => i.state === 'owner').map((i) => ({ title: i.title, file: i.file, gate: i.gate, ask: i.ask })),
        waitingOnClaude: b.items.filter((i) => i.state === 'claude').map((i) => ({ title: i.title, file: i.file, gate: i.gate })),
        queuedForCodex: b.items.filter((i) => i.state === 'codex').map((i) => ({ title: i.title, file: i.file })),
      })),
    };
    try { fs.writeFileSync(nodePath.join(this.dir, 'status.json'), JSON.stringify(out, null, 1)); } catch (e) { console.error('Brain Network status', e); }
  }

  /* ---------- writing: owner replies ---------- */
  async reply(it, verdict, note, label) {
    const f = this.app.vault.getAbstractFileByPath(it.file);
    if (!f) throw new Error('note not found');
    /* a free-form reply hands the ball to Claude, except while a Codex run is queued */
    const D = this.settings.dispatch, decision = it.gate === 'decision';
    /* approving a decision still leaves work: Claude records and carries it out */
    const toClaude = D.on && (verdict === 'reply' || verdict === 'back' || verdict === 'note' || (verdict === 'approve' && decision));
    const next = { reply: it.state === 'codex' ? 'codex' : 'claude', approve: decision && D.on ? 'claude' : 'done', back: 'claude', park: 'parked', revive: it.gate ? 'claude' : 'planned', note: it.state }[verdict];
    const day = today();
    const words = { reply: 'Reply', approve: it.gate === 'decision' ? 'Decided' : 'Approved', back: 'Sent back', park: 'Parked', revive: 'Brought back', note: 'Note' }[verdict];
    const line = `- ${day} · **${words}**${it.plan ? ` (${it.title})` : ''}${note ? ': ' + note.replace(/\s*\n\s*/g, ' ') : ''} (Brain Network)`;
    const undo = { item: it.id, file: it.file, label, verdict, line, plan: it.plan, planIndex: it.planIndex, prevState: it.state, prevStatus: null };
    await this.app.fileManager.processFrontMatter(f, (fm) => {
      if (it.plan) {
        const e = fm['brain-plan'] && fm['brain-plan'][it.planIndex];
        if (e) { undo.prevState = e.state; e.state = next; }
      } else {
        fm['brain-state'] = next;
        if (next !== it.state) {
          undo.prevStatus = fm.status;
          fm.status = {
            done: `${words.toLowerCase()} by the owner ${day}`,
            claude: verdict === 'reply' ? `owner replied ${day}; Claude to read the Owner review note and decide the next step` : `${words.toLowerCase()} by the owner ${day}; Claude to act on the Owner review note`,
            parked: `parked by the owner ${day}`, planned: `brought back by the owner ${day}`,
          }[next] || fm.status;
        }
      }
    });
    await this.app.vault.process(f, (text) => insertOwnerReview(text, line));
    const ev = { t: Date.now(), at: new Date().toISOString(), id: it.id, brain: this.model.byBrain.get(it.brain).name, item: it.title, file: it.file, verdict, note, from: it.state, to: next };
    undo.t = ev.t;
    if (toClaude) {
      const run = this.dispatch({ brain: it.brain, item: it.id, file: it.plan ? it.file : it.file, title: it.title, text: verdict === 'approve' ? `Approved.${note ? ' ' + note : ''}` : note });
      ev.dispatched = run.id; undo.run = run;
    }
    fs.appendFileSync(nodePath.join(this.dir, 'replies.jsonl'), JSON.stringify(ev) + '\n');
    this.lastAction = undo;
    this.readLive();
    const v = this.views()[0];
    if (v) v.stage.burst(it.id, { done: 'you', claude: 'claude', parked: 'muted', planned: 'base', owner: 'you' }[next] || 'base');
    new Notice(`${words}: ${it.title}`);
  }
  async undo() {
    const u = this.lastAction;
    if (!u) return;
    if (u.run && (u.run.status === 'queued' || u.run.status === 'running')) this.stopRun(u.run);
    const f = this.app.vault.getAbstractFileByPath(u.file);
    if (!f) return;
    await this.app.fileManager.processFrontMatter(f, (fm) => {
      if (u.plan) { const e = fm['brain-plan'] && fm['brain-plan'][u.planIndex]; if (e) e.state = u.prevState; }
      else { fm['brain-state'] = u.prevState; if (u.prevStatus != null) fm.status = u.prevStatus; }
    });
    await this.app.vault.process(f, (text) => removeLine(text, u.line));
    fs.appendFileSync(nodePath.join(this.dir, 'replies.jsonl'), JSON.stringify({ t: Date.now(), at: new Date().toISOString(), verdict: 'undo', undoes: u.t, file: u.file }) + '\n');
    this.lastAction = null;
    this.readLive();
    new Notice('Reply undone.');
  }
  async setParent(b, parent, add) {
    const f = this.app.vault.getAbstractFileByPath(b.file);
    const pf = this.app.vault.getAbstractFileByPath(parent.file);
    if (!f || !pf) return;
    const link = '[[' + this.app.metadataCache.fileToLinktext(pf, b.file, true) + ']]';
    await this.app.fileManager.processFrontMatter(f, (fm) => {
      const cur = list(fm['brain-parents']).map(String);
      const keep = cur.filter((r) => { const d = this.app.metadataCache.getFirstLinkpathDest(linkTarget(r), b.file); return !(d && d.path === parent.file); });
      fm['brain-parents'] = add ? keep.concat(link) : keep;
      if (!fm['brain-parents'].length) delete fm['brain-parents'];
    });
  }
};

function insertOwnerReview(text, line) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((l) => /^## Owner review\s*$/.test(l));
  if (h < 0) return text.replace(/\s*$/, '') + nl + nl + '## Owner review' + nl + line + nl;
  let end = h + 1;
  while (end < lines.length && !/^#{1,2} /.test(lines[end])) end++;
  while (end > h + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, line);
  return lines.join(nl);
}
function removeLine(text, line) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const i = lines.lastIndexOf(line);
  if (i >= 0) lines.splice(i, 1);
  const h = lines.findIndex((l) => /^## Owner review\s*$/.test(l));
  if (h >= 0 && (h + 1 >= lines.length || /^#{1,2} /.test(lines[h + 1]) || lines.slice(h + 1).every((l) => !l.trim()))) {
    let s = h; while (s > 0 && !lines[s - 1].trim()) s--;
    lines.splice(s, lines.length - s);
    return lines.join(nl) + nl;
  }
  return lines.join(nl);
}
