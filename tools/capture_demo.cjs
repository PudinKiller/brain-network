#!/usr/bin/env node
'use strict';

// Drive only the fictional demo through Obsidian's CLI and the plugin view API.
// Raw frames and logs stay outside the repo; the selected deliverables go in docs/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const frames = path.resolve(root, '../.bn-tools/captures');
const cli = process.env.OBSIDIAN_CLI || path.join(process.env.LOCALAPPDATA, 'Programs/Obsidian/Obsidian.com');
const run = (...args) => {
  const r = spawnSync(cli, ['vault=demo-vault', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.error || r.status !== 0 || /^Error:/m.test(r.stdout)) throw r.error || Error(r.stderr || r.stdout);
  return r.stdout.trim();
};
const evaluate = code => run('eval', 'code=' + code);
const view = "app.workspace.getLeavesOfType('brain-network-view')[0].view";
const pause = ms => evaluate(`new Promise(r=>setTimeout(r,${ms}))`);
const capture = name => {
  pause(800);
  run('dev:screenshot', 'path=' + path.join(frames, name + '.png'));
  console.log('Captured ' + name);
};

fs.mkdirSync(frames, { recursive: true });
run('dev:debug', 'on');
if (process.argv[2] === 'verify') {
  fs.copyFileSync(path.join(root, 'demo-vault/Assets/control-cards.png'), path.join(frames, 'file-url-reference.png'));
  const evidence = evaluate(`(async()=>{
    if(app.vault.getName()!=='demo-vault')throw Error('Wrong vault');
    const p=app.plugins.plugins['brain-network'];
    if(p.settings.dispatch.on!==false)throw Error('Dispatch must be off');
    const absolute=require('path').resolve(app.vault.adapter.getBasePath(),'../../.bn-tools/captures/file-url-reference.png');
    const forms=['Assets/control-cards.png','../Assets/control-cards.png','[[Assets/control-cards.png]]','[[control-cards]]',
      '![[control-cards.png|Cards]]','[Cards](../Assets/control-cards.png)','![Cards](<../Assets/control-cards.png> "Reference")',require('url').pathToFileURL(absolute).href];
    const checks=[];
    for(let index=0;index<forms.length;index++){
      const m=p.mediaEntry(forms[index],'Playtest/Control Cards.md');
      if(!m)throw Error('Unresolved review form: '+(index+1));
      const image=new Image();image.src=m.src;await image.decode();
      if(!m.exists||image.naturalWidth!==1000)throw Error('Image form failed: '+index);
      checks.push({form:index+1,width:image.naturalWidth,height:image.naturalHeight});
    }
    return JSON.stringify({vault:app.vault.getName(),dispatch:p.settings.dispatch.on,brains:p.model.brains.length,items:p.model.items.length,images:checks});
  })()`);
  fs.writeFileSync(path.join(frames, 'live-verification.txt'), evidence + '\n' + run('dev:errors') + '\n' + run('dev:console', 'level=error') + '\n');
  console.log(evidence);
  process.exit();
}

run('command', 'id=brain-network:open');
evaluate(`(()=>{if(app.vault.getName()!=='demo-vault'||app.plugins.plugins['brain-network'].settings.dispatch.on!==false)throw Error('Unsafe demo');const v=${view};v.plugin.fresh?.clear();v.plugin.live.files.clear();v.plugin.live.brains.clear();v.closeLightbox();v.setDrawer(false,true);if(v.inboxOpen())v.toggleInbox();app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();v.exitStrand();v.select(null);})()`);
pause(1600);
evaluate(`(()=>{const v=${view};v.stage.userMoved=false;v.stage.tween(v.stage.fitCam(),1);})()`);
capture('01-studio-map');
fs.copyFileSync(path.join(frames, '01-studio-map.png'), path.join(root, 'docs/01-studio-map.png'));

evaluate(`${view}.select('Accessibility/Accessibility.md')`);
// Keep the rest of the hierarchy visible while the card identifies both parents.
evaluate(`${view}.stage.sel=null`);
capture('02-hierarchy');
fs.copyFileSync(path.join(frames, '02-hierarchy.png'), path.join(root, 'docs/02-hierarchy.png'));

evaluate(`${view}.enterStrand('Shader Lab/Lantern Shader/Lantern Shader.md')`);
pause(1400);
evaluate(`(()=>{const v=${view};v.select(null);v.stage.tween(v.stage.fitCam(),1);})()`);
capture('03-states');

for (const [file, name] of [['Flicker Clamp', '04-codex-brief'], ['Pulse Envelope', '05-claude-result'], ['Night Backdrop', '06-owner-card']]) {
  evaluate(`${view}.focusItem('Shader Lab/Lantern Shader/${file}.md')`);
  pause(700);
  evaluate(`(async()=>{const v=${view};await v.loadMoons(v.model.byItem.get(v.sel));})()`);
  capture(name);
}
evaluate(`(()=>{const v=${view};v.moons.find(m=>m.media&&m.media.exists).el.click();})()`);
pause(500);
const lightbox = evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.bn-lightbox img')).map(i=>({loaded:i.complete&&i.naturalWidth>0,width:i.naturalWidth,height:i.naturalHeight})))`);
if (!lightbox.includes('"loaded":true')) throw Error('Lightbox image failed');
capture('07-owner-lightbox-a');
fs.copyFileSync(path.join(frames, '07-owner-lightbox-a.png'), path.join(root, 'docs/03-owner-gate.png'));
evaluate(`${view}.lbStep(1)`);
capture('08-owner-lightbox-b');
evaluate(`${view}.closeLightbox()`);

for (const [file, name] of [['Flicker Clamp', '04b-brief-note'], ['Pulse Envelope', '05b-result-note']]) {
  evaluate(`(async()=>{const f=app.vault.getAbstractFileByPath('Shader Lab/Lantern Shader/${file}.md');const leaf=app.workspace.getLeaf('tab');await leaf.openFile(f,{state:{mode:'preview'}});})()`);
  pause(600);
  evaluate(`(()=>{const e=document.querySelector('.workspace-leaf.mod-active .markdown-preview-view');const h=e.querySelector('h1');e.scrollTop+=h.getBoundingClientRect().top-e.getBoundingClientRect().top-30;})()`);
  capture(name);
}
evaluate(`(async()=>{const f=app.vault.getAbstractFileByPath('Shader Lab/Lantern Shader/Night Palette.md');const leaf=app.workspace.getLeaf('tab');await leaf.openFile(f,{state:{mode:'preview'}});})()`);
pause(600);
evaluate(`(()=>{const e=document.querySelector('.workspace-leaf.mod-active .markdown-preview-view');const h=e.querySelector('h1');e.scrollTop+=h.getBoundingClientRect().top-e.getBoundingClientRect().top-30;})()`);
capture('09-done-trail');
console.log(run('dev:errors'));
console.log(run('dev:console', 'level=error'));
