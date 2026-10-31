#!/usr/bin/env node
'use strict';

// This demo uses a deliberately small YAML subset: unquoted field names,
// JSON scalars/flow values, and two-space block sequences of JSON values.
// JSON flow values are valid YAML 1.2. Reject all other syntax rather than
// silently accepting an unsupported YAML feature. No dependencies are needed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const vault = path.join(root, 'demo-vault');
const privateNames = new Set(['data.json', 'status.json', 'runs.jsonl', 'replies.jsonl', 'hook-state.json']);

function filesAt(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    if (['.git', '.tools-cache'].includes(e.name)) return [];
    const rel = prefix + e.name;
    return e.isDirectory() ? filesAt(path.join(dir, e.name), rel + '/') : [rel];
  });
}

function frontMatter(text, file) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  assert(end > 0, `${file}: unclosed front matter`);
  const data = Object.create(null);
  let sequence = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const listEntry = /^  - (.+)$/.exec(line);
    if (listEntry) {
      assert(sequence, `${file}:${i + 1}: sequence has no field`);
      data[sequence].push(JSON.parse(listEntry[1]));
      continue;
    }
    const field = /^([a-z][a-z0-9-]*):(?: (.+))?$/.exec(line);
    assert(field, `${file}:${i + 1}: unsupported YAML syntax`);
    assert(!Object.hasOwn(data, field[1]), `${file}:${i + 1}: duplicate field`);
    sequence = field[2] === undefined ? field[1] : null;
    data[field[1]] = sequence ? [] : JSON.parse(field[2]);
  }
  return data;
}

function main() {
  const all = filesAt(root);
  const settingsPath = 'demo-vault/.obsidian/plugins/brain-network/data.json';
  for (const p of all.filter(p => privateNames.has(path.posix.basename(p)) && p !== settingsPath)) {
    const ignored = require('node:child_process').spawnSync('git', ['check-ignore', '--quiet', p], { cwd: root, windowsHide: true });
    assert.equal(ignored.status, 0, `Private runtime file must be ignored: ${p}`);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(root, settingsPath), 'utf8'));
  assert.equal(settings.dispatch.on, false, 'Demo dispatch must stay off');
  assert(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').startsWith('MIT License\n\nCopyright (c) 2026 PudinKiller\n'));
  const markdown = all.filter(p => p.endsWith('.md') && p !== 'FIX_NOTES.md');
  const parsed = new Map(markdown.map(p => [p, frontMatter(fs.readFileSync(path.join(root, p), 'utf8'), p)]));
  console.log(`YAML: ${markdown.length} Markdown files checked; ${[...parsed.values()].filter(Boolean).length} front-matter blocks parsed; no errors.`);

  const vaultFiles = filesAt(vault);
  const files = vaultFiles.map(p => ({ path: p, basename: path.posix.basename(p, path.posix.extname(p)), extension: path.posix.extname(p).slice(1), parent: { path: path.posix.dirname(p) === '.' ? '/' : path.posix.dirname(p) } }));
  const byPath = new Map(files.map(f => [f.path, f]));
  const fmAt = p => parsed.get('demo-vault/' + p);
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = source.indexOf('const VIEW =');
  const end = source.indexOf('function rng(');
  assert(start > 0 && end > start, 'Plugin model boundary changed; inspect checker');
  const reviewStart = source.indexOf('  resourcePrefix() {');
  const reviewEnd = source.indexOf('  /* Review images:', reviewStart);
  assert(reviewStart > end && reviewEnd > reviewStart, 'Review resolver boundary changed; inspect checker');
  const { buildModel, linkTarget, ReviewResolver } = vm.runInNewContext(source.slice(start, end)
    + '\nclass ReviewResolver {\n' + source.slice(reviewStart, reviewEnd) + '\n}\n({buildModel, linkTarget, ReviewResolver})',
    { require, fs, nodePath: path }, { timeout: 1000 });
  const resolve = (raw, from) => {
    const target = linkTarget(raw).replace(/#.*$/, '');
    const options = [path.posix.join(path.posix.dirname(from), target), target];
    for (const p of options) for (const candidate of [p, p + '.md']) if (byPath.has(candidate)) return byPath.get(candidate);
    const matches = files.filter(f => f.path === target || (f.extension === 'md' && f.basename === target) || f.path.endsWith('/' + target));
    return matches.length === 1 ? matches[0] : null;
  };
  const app = {
    vault: { getMarkdownFiles: () => files.filter(f => f.extension === 'md'), getAbstractFileByPath: p => byPath.get(p),
      getResourcePath: f => 'app://demo/' + encodeURI(path.join(vault, f.path).replace(/\\/g, '/')),
      adapter: { getBasePath: () => vault, getResourcePath: p => 'app://demo/' + encodeURI(path.join(vault, p).replace(/\\/g, '/')) } },
    metadataCache: { getFileCache: f => ({ frontmatter: fmAt(f.path), listItems: [] }), getFirstLinkpathDest: resolve }
  };
  const model = buildModel(app);
  const reviews = new ReviewResolver(); reviews.app = app;
  assert.equal(model.brains.length, 8);
  assert.equal(model.items.length, 36);
  assert.equal(model.broken.length, 0);
  const studio = model.brains.find(b => b.name === 'Studio');
  assert(studio && studio.file === 'Studio Home.md');
  assert.equal(studio.children.length, 4);
  for (const brain of model.brains) {
    assert.equal(brain.level, brain === studio ? 1 : ['Lantern Shader', 'Store Page', 'Accessibility'].includes(brain.name) ? 3 : 2);
    assert.equal(brain.parents.length, brain === studio ? 0 : brain.name === 'Accessibility' ? 2 : 1);
    assert(byPath.has(path.posix.join(brain.folder, 'AGENTS.md')));
    assert(byPath.has(path.posix.join(brain.folder, 'Decision Log.md')));
    assert(brain.items.length >= 2);
  }
  const access = model.brains.find(b => b.name === 'Accessibility');
  assert.deepEqual(Array.from(access.parents).sort(), ['Level Tools/Level Tools.md', 'Playtest/Playtest.md']);
  assert(model.items.some(i => i.after.some(id => model.byItem.get(id).brain !== i.brain)), 'Missing cross-brain dependency');
  const states = ['owner', 'claude', 'codex', 'done', 'planned', 'parked'];
  const gates = ['art', 'decision', 'look', 'approval'];
  for (const state of states) assert(model.items.some(i => i.state === state), `Missing state: ${state}`);
  for (const gate of gates) assert(model.items.some(i => i.gate === gate), `Missing gate: ${gate}`);
  for (const [p, fm] of parsed) {
    if (!fm) continue;
    if (fm['brain-state']) assert(states.includes(fm['brain-state']), `${p}: unknown state`);
    if (fm['brain-gate']) assert(gates.includes(fm['brain-gate']), `${p}: unknown gate`);
    for (const entry of fm['brain-plan'] || []) {
      assert.equal(typeof entry.title, 'string');
      assert(states.includes(entry.state), `${p}: invalid plan state`);
      if (entry.gate) assert(gates.includes(entry.gate), `${p}: invalid plan gate`);
    }
  }
  let reviewCount = 0, dependencies = 0;
  const images = new Set();
  for (const item of model.items) {
    assert(item.ask.trim(), `${item.title}: missing actionable ask`);
    assert(item.stream && model.byBrain.get(item.brain).streams.includes(item.stream), `${item.title}: undeclared stream`);
    assert.equal(item.after.length, item.afterRefs.length, `${item.title}: unresolved dependency`);
    dependencies += item.after.length;
    for (const ref of item.review) {
      const entry = reviews.mediaEntry(ref, item.file);
      assert(entry && entry.exists && entry.src && entry.kind === 'img', `${item.title}: missing review image ${ref}`);
      const bytes = fs.readFileSync(entry.abs);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${ref}: invalid PNG signature`);
      assert.equal(bytes.readUInt32BE(16), 1000);
      assert.equal(bytes.readUInt32BE(20), 600);
      images.add(path.relative(vault, entry.abs)); reviewCount++;
    }
    if (item.plan) {
      assert(item.link && resolve(item.link, item.file), `${item.title}: missing plan result link`);
      const heading = /#([^\]|]+)/.exec(item.link);
      if (heading) {
        const dest = resolve(item.link, item.file);
        assert(fs.readFileSync(path.join(vault, dest.path), 'utf8').includes('\n## ' + heading[1] + '\n'), `${item.title}: missing result section`);
      }
    } else assert(/^## Result\s*$/m.test(fs.readFileSync(path.join(vault, item.file), 'utf8')), `${item.title}: missing Result section`);
  }
  const control = path.join(vault, 'Assets/control-cards.png');
  const forms = ['Assets/control-cards.png', '../Assets/control-cards.png', '[[Assets/control-cards.png]]',
    '[[control-cards]]', '![[control-cards.png|Cards]]', '[Cards](../Assets/control-cards.png)',
    '![Cards](<../Assets/control-cards.png> "Reference")', require('node:url').pathToFileURL(control).href];
  for (const form of forms) {
    const entry = reviews.mediaEntry(form, 'Playtest/Control Cards.md');
    assert(entry && entry.exists && entry.src && path.resolve(entry.abs) === control, `Review form failed: ${form}`);
  }
  assert.equal(reviews.mediaEntry('Assets/absent.png', 'Studio Home.md').exists, false);
  // Resolve every wiki link, including images embedded in note bodies.
  for (const f of files.filter(f => f.extension === 'md')) {
    const text = fs.readFileSync(path.join(vault, f.path), 'utf8');
    for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) assert(resolve(match[0], f.path) || reviews.mediaEntry(match[0], f.path)?.exists, `${f.path}: missing wiki link ${match[1]}`);
  }
  const reviewNotes = files.filter(f => f.extension === 'md' && /^## Owner review\s*$/m.test(fs.readFileSync(path.join(vault, f.path), 'utf8')));
  assert.equal(reviewNotes.length, 3);
  for (const f of reviewNotes) assert(/^- \d{4}-\d{2}-\d{2} \*\*Reply:\*\* .+/m.test(fs.readFileSync(path.join(vault, f.path), 'utf8')));
  for (const rel of ['main.js', 'styles.css', 'manifest.json', 'hooks/replies.cjs']) {
    assert(fs.readFileSync(path.join(root, rel)).equals(fs.readFileSync(path.join(vault, '.obsidian/plugins/brain-network', rel))), `Bundled copy differs: ${rel}`);
  }
  const pluginFiles = filesAt(path.join(vault, '.obsidian/plugins/brain-network')).filter(p => !privateNames.has(p) || p === 'data.json');
  assert.deepEqual(pluginFiles.sort(), ['data.json', 'hooks/replies.cjs', 'main.js', 'manifest.json', 'styles.css']);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.author, 'PudinKiller');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.isDesktopOnly, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(vault, '.obsidian/community-plugins.json'), 'utf8')), ['brain-network']);
  console.log(`Plugin model: ${model.brains.length} brains, ${model.items.length} items (${model.items.filter(i => i.plan).length} plan entries), ${dependencies} dependencies; three levels and two parents validated.`);
  console.log('States: ' + states.map(s => `${s}=${model.items.filter(i => i.state === s).length}`).join(', ') + '.');
  console.log(`Review paths: ${reviewCount} references resolve to ${images.size} PNGs (1000 x 600); eight path/link forms and a missing file checked with the plugin resolver.`);
  console.log('Bundle: four plugin files byte-identical to root copies, safe settings with dispatch off; MIT license present.');
  console.log('Owner review: three populated notes. UI and media playback require separate hands-on checks.');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { frontMatter };
