#!/usr/bin/env node
'use strict';

// Claude Code UserPromptSubmit hook for Brain Network. Hands Claude the owner's replies from the
// Obsidian map that this session has not seen yet. Each session sees each reply once; a new session
// sees the last 24 hours. It records which session read each reply first, so the map can show
// "read by Claude". Never blocks: any error exits 0 silently.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.resolve(__dirname, '..');
const REPLIES = path.join(DIR, 'replies.jsonl');
const STATE = path.join(DIR, 'hook-state.json');
const NEW_SESSION_WINDOW = 24 * 60 * 60 * 1000;
const KEEP = 30 * 24 * 60 * 60 * 1000;

function readState() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { raw = {}; }
  if (raw.sessions) return { sessions: raw.sessions, delivered: raw.delivered || {} };
  // first format: { "<session id>": lastSeen }
  const sessions = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') sessions[k] = v;
  return { sessions, delivered: {} };
}

function main(input) {
  if (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit') return;
  // a run the map started already has its message in its prompt
  if (process.env.BRAIN_NETWORK_RUN) return;
  const sid = input.session_id || 'unknown';
  if (!fs.existsSync(REPLIES)) return;
  const state = readState();
  const since = state.sessions[sid] || Date.now() - NEW_SESSION_WINDOW;
  const all = fs.readFileSync(REPLIES, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const undone = new Set(all.filter((e) => e.verdict === 'undo').map((e) => e.undoes));
  // replies dispatched to a brain's Claude session are handled there; other sessions never act on them
  const fresh = all.filter((e) => e.t > since && e.verdict !== 'undo' && !undone.has(e.t) && !e.dispatched);
  const lateUndos = all.filter((e) => e.verdict === 'undo' && e.t > since && e.undoes <= since);
  const now = Date.now();
  state.sessions[sid] = all.reduce((m, e) => Math.max(m, e.t || 0), since);
  for (const e of fresh) if (!state.delivered[e.t]) state.delivered[e.t] = { sid, at: now };
  for (const k of Object.keys(state.sessions)) if (state.sessions[k] < now - KEEP) delete state.sessions[k];
  for (const k of Object.keys(state.delivered)) if (Number(k) < now - KEEP) delete state.delivered[k];
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(state));
  fs.renameSync(STATE + '.tmp', STATE);
  if (!fresh.length && !lateUndos.length) return;

  const words = { reply: 'replied', approve: 'approved', back: 'sent back', park: 'parked', revive: 'brought back', note: 'note' };
  const lines = fresh.map((e) => `- [${e.brain}] ${e.item}: ${words[e.verdict] || e.verdict}${e.note ? ` — "${e.note}"` : ''} (brain-state now ${e.to}; ${e.file})`)
    .concat(lateUndos.map((e) => `- The owner undid an earlier reply on ${e.file}; its brain-state is back to what it was.`));
  const text = [
    'Brain Network: the owner replied from the Obsidian map since your last prompt.',
    'Each reply is also in its note under "## Owner review", and the note\'s brain-state is already updated.',
    '"replied" is free-form: work out what the owner means (accept, a decision, change course, redo, park, or a question back) and act on that.',
    'Afterwards set brain-state and status to match (done; owner with a new brain-ask if you need them again; codex with a brief), and record decisions in the brain\'s Decision Log.',
    'If the user\'s current message is about something else, do not switch tasks: tell them in one line that these replies are waiting.',
    ...lines,
  ].join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try { main(JSON.parse(raw || '{}')); } catch { /* never block Claude */ }
  process.exit(0);
});
