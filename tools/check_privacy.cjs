#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const terms = ['duncan', 'Ken', 'Deng', '留美', 'moshuixin', 'gmail', 'Knowledge Base', 'C:\\Users', 'Epic', 'Stormbound', 'Carnegie', 'CMU', 'visa', 'resume', 'token', 'gho_', 'sk-ant'];
const privateNames = ['data.json', 'status.json', 'runs.jsonl', 'replies.jsonl', 'hook-state.json'];
const base = ['--hidden', '--no-ignore', '--sort', 'path', '--with-filename', '--no-text', '-n', '-i', '-F', ...privateNames.flatMap(p => ['--glob', '!' + p])];
const run = args => {
  const result = spawnSync('rg', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error) throw result.error;
  assert([0, 1].includes(result.status), result.stderr || 'Search failed');
  return (result.stdout || '').trimEnd().split(/\r?\n/).filter(Boolean);
};
const scan = (term, omitReport) => run([...base, ...(omitReport ? ['--glob', '!PRIVACY_CHECK.md'] : []), '-e', term, '.']).map(line => {
  const match = /^(.*?):(\d+):(.*)$/.exec(line);
  assert(match, 'Unexpected search output');
  return { file: match[1].replace(/^\.\\/, '').replace(/\\/g, '/'), line: Number(match[2]), text: match[3] };
});
const explanation = (file, term) => {
  if (file === 'tools/check_privacy.cjs') return 'Intentional search vocabulary, report text, or audit logic in this script.';
  if (file === 'tools/check_yaml.cjs' && term === 'Ken') return 'Substring in the model.broken assertion for malformed front matter; no person is named.';
  if (file === 'FIX_NOTES.md' && term === 'Ken') return 'Substring in broken-image descriptions in the ignored local repair notes; no person is named.';
  if (file === '.git/hooks/applypatch-msg.sample' && term === 'Ken') return 'Substring in the word taken in a stock Git hook comment. This metadata is not a published project file.';
  if (file === '.git/hooks/pre-commit.sample' && term === 'visa') return 'Substring in the word advisable in a stock Git hook message. This metadata is not a published project file.';
  if (file === '.git/hooks/fsmonitor-watchman.sample' && ['Ken', 'token'].includes(term)) return 'Stock Git file-watcher state identifiers and comments; no credential value. This metadata is not a published project file.';
  if (['main.js', 'demo-vault/.obsidian/plugins/brain-network/main.js'].includes(file)) {
    if (term === 'Ken') return 'Substring in broken-front-matter identifiers or context-usage words; no person is named.';
    if (term === 'resume') return 'Session continuation identifiers/flags, or the audio-context method; no employment document.';
    if (term === 'token') return 'Context-usage labels, counters, or API usage field names; no credential value.';
  }
  if (['styles.css', 'demo-vault/.obsidian/plugins/brain-network/styles.css'].includes(file) && term === 'Ken') return 'Substring in the .bn-broken warning selector; no person is named.';
  throw new Error(`Unexplained match: ${file} (${term}). Review it before publishing.`);
};

function main() {
  assert(!fs.existsSync(path.join(root, '.tools-cache')), 'Remove temporary tool cache before auditing the entire directory');
  const outside = new Map(terms.map(term => [term, scan(term, true)]));
  const detail = [];
  for (const term of terms) {
    const groups = new Map();
    for (const hit of outside.get(term)) {
      explanation(hit.file, term);
      if (!groups.has(hit.file)) groups.set(hit.file, []);
      groups.get(hit.file).push(hit.line);
    }
    if (!groups.size) continue;
    detail.push(`### \`${term}\``, '');
    for (const [file, lines] of groups) detail.push(`- \`${file}\`, lines ${lines.join(', ')} — ${explanation(file, term)}`);
    detail.push('');
  }
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const options = '--hidden --no-ignore --sort path --with-filename --no-text -n -i -F ' + privateNames.map(p => '--glob ' + quote('!' + p)).join(' ');
  const termFlags = terms.map(term => '-e ' + quote(term)).join(' ');
  const handle = run(['-n', '-i', '-F', '-e', 'PudinKiller', '--', 'manifest.json', 'demo-vault/.obsidian/plugins/brain-network/manifest.json']);
  assert.equal(handle.length, 2);
  let report = [
    '# Privacy check', '',
    'Checked 2026-10-31. [hands-on] Searches ran from the repository root using ripgrep. Searches are case-insensitive fixed substrings, so matches inside longer words count.', '',
    'Scope: the whole directory, including hidden files, ignored files, and local Git metadata. Binary PNGs and MP4s are skipped by ripgrep\'s default binary detection; inspect their pixels separately. The five runtime basenames below are excluded from text scanning. The bundled data.json is validated separately by check_yaml.cjs, which requires dispatch off. Local runtime logs stay ignored. Media tools and raw captures live outside the repository.', '',
    '## Commands run', '',
    'The script runs each of the 17 terms separately with the same options to build the table. These combined searches were also run:', '',
    '```powershell',
    'rg ' + options + " --glob '!PRIVACY_CHECK.md' " + termFlags + ' .',
    'rg ' + options + ' ' + termFlags + ' .',
    "rg -n -i -F -e 'PudinKiller' -- manifest.json demo-vault/.obsidian/plugins/brain-network/manifest.json",
    '```', '',
    'The first search omits this report so each source hit can be explained below. The second includes the finished report. Report matches are intentional: the requested search terms, the commands, the table, and explanations of source matches. Report line numbers below identify every such matching line.', '',
    '## Results', '',
    '| Pattern | Matching lines outside report | Report line numbers | Total matching lines |',
    '| --- | ---: | --- | ---: |',
    ...terms.map((term, i) => `| \`${term}\` | ${outside.get(term).length} | @@LINES${i}@@ | @@TOTAL${i}@@ |`), '',
    'Every hit outside this report is listed by file and line below. Repeated bundled-source hits come from the required demo plugin copy. No unexplained hits were found. A text search cannot establish that arbitrary future content is safe to publish.', '',
    ...detail,
    '## Public author handle', '',
    'The exact public handle `PudinKiller` appears as the author in both manifests (line 7). These two hits are expected. LICENSE and the README use the same public copyright holder.', '',
    '## Reproduce', '',
    'Run `node tools/check_privacy.cjs`. It rewrites this report, repeats the full-directory searches, checks the resulting counts, and fails on an unexplained source hit. After adding screenshots or a clip, inspect those files separately and rerun this audit.', ''
  ].join('\n');
  const reportPath = path.join(root, 'PRIVACY_CHECK.md');
  fs.writeFileSync(reportPath, report);
  const full = new Map(terms.map(term => [term, scan(term, false)]));
  for (let i = 0; i < terms.length; i++) {
    const hits = full.get(terms[i]);
    const self = hits.filter(hit => hit.file === 'PRIVACY_CHECK.md');
    assert.equal(hits.length, outside.get(terms[i]).length + self.length);
    report = report.replace(`@@LINES${i}@@`, self.map(hit => hit.line).join(', ') || 'none').replace(`@@TOTAL${i}@@`, String(hits.length));
  }
  fs.writeFileSync(reportPath, report);
  // Counts and line positions are stable: replacements add only digits and punctuation.
  for (const term of terms) assert.deepEqual(scan(term, false), full.get(term).map(hit => ({ ...hit, text: hit.file === 'PRIVACY_CHECK.md' ? report.split('\n')[hit.line - 1] : hit.text })));
  const combined = [...base, ...terms.flatMap(term => ['-e', term]), '.'];
  run([...combined.slice(0, -1), '--glob', '!PRIVACY_CHECK.md', '.']);
  run(combined);
  console.log(`Privacy: ${terms.length} requested patterns checked across the full directory, including this report.`);
  console.log('Every source hit explained; no unexplained hits. Public author handle appears in both manifests.');
  console.log('PRIVACY_CHECK.md contains exact commands, counts, and file/line explanations.');
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
