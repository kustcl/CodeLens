// Actual-browser regression: run from CodeLens/ with an optional local browser executable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const html = path.resolve(process.argv[2] ?? 'output/index.html');
const nanochat = path.resolve(process.env.CODELENS_NANOCHAT_ROOT ?? '../nanochat-master');
const moduleName = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
const browser = await chromium.launch(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {});
const page = await browser.newPage({viewport:{width:1440,height:900},offline:true});
page.setDefaultTimeout(5000);
const errors = [], requests = [];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
const $=sel=>page.locator(sel), node=id=>$(`[data-node="${id}"]`), src=line=>$(`.code-row[data-line="${line}"] .line-button`);
const anchor=()=>$('.code-row.anchor').getAttribute('data-line');
const selected=()=>$('.node.selected').getAttribute('data-node');
async function nodeClick(id){
  const box=node(id);
  // Use real source navigation to pan to an offscreen node first when needed.
  await box.locator('.node-main').click();
}
async function file(name){await $('#search-files').fill(name);await $(`button[data-path="${name}"]`).click();}
const metric=()=>page.evaluate(()=>({top:document.querySelector('#source').scrollTop,x:document.querySelector('#source').scrollLeft,pan:document.querySelector('#scene').style.cssText}));
try {
  await page.goto(pathToFileURL(html).href);
  assert.equal(await $('#project').textContent(),'nanochat-master');
  for(const selector of ['#home-top','#overview','.tree-box','#search-files']){
    assert.equal(await $(selector).evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  }
  assert.equal(await $('details[open] > .tree-children').first().evaluate(e=>getComputedStyle(e,'::before').borderInlineStartWidth),'1px');
  assert.match(await $('[data-path="nanochat/gpt.py"] .desc').textContent(),/前向传播/);
  const dev=$('summary[data-path="dev"]');await dev.click();assert.equal(await $('[data-path="dev/repackage_data_reference.py"]').isVisible(),true);await dev.click();
  await file('nanochat/gpt.py');
  assert.equal(await $('#file-path').textContent(),'nanochat/gpt.py');
  const expected=fs.readFileSync(path.join(nanochat,'nanochat/gpt.py'),'utf8').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\n$/,'').split('\n');
  assert.deepEqual(await $('.src').allTextContents(),expected);
  assert.deepEqual(await $('.line-button').allTextContents(),expected.map((_,i)=>String(i+1)));
  assert.ok(await $('.kw').count()>0);
  assert.equal(await $('#scopes').inputValue(),'GPT.forward');
  assert.equal(await selected(),'460:8');
  assert.equal(await $('#viewport').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  assert.equal(await $('#source').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(21, 25, 31)');
  assert.equal(await $('.flow-region').count()>0,true);
  assert.equal(await $('path[data-from="460:8"][data-to^="group:"]').count(),1);
  const group=$('.node.group').filter({hasText:'检查并切出 RoPE 缓存'});
  await group.locator('.node-main').click();assert.equal(await anchor(),'463');
  assert.ok(await $('.code-row[data-line="468"]').evaluate(el=>el.classList.contains('active')));
  await group.locator('[data-toggle]').click();assert.equal(await node('468:8').count(),1);
  await node('463:8').locator('[data-toggle]').click();assert.equal(await group.count(),1);
  await src(468).click();assert.equal(await selected(),'468:8');
  await src(476).click();assert.equal(await selected(),'476:8');
  const yes=$('[data-branch="Yes"]').first();await yes.click();assert.equal(await anchor(),'478');
  assert.ok(await $('path.edge.visited').count()>0);
  await $('#prev').click();assert.equal(await selected(),'476:8');
  await $('[data-branch="No"]').first().click();assert.equal(await anchor(),'483');
  await $('#path-mode').selectOption('no');assert.ok(await $('.node.subdued').count()>0);assert.equal(await selected(),'460:8');
  await $('#path-mode').selectOption('all');
  await $('#speed').selectOption('2');await $('#play').click();assert.match(await $('#play').textContent(),/暂停/);
  await page.waitForFunction(()=>document.querySelector('.node.selected')?.dataset.node!=='460:8');
  await $('#play').click();const stopped=await selected();await page.waitForTimeout(650);assert.equal(await selected(),stopped);
  await $('#reset').click();assert.equal(await selected(),'460:8');assert.equal(await $('path.edge.visited').count(),0);
  await $('#next').click();assert.notEqual(await selected(),'460:8');await $('#prev').click();assert.equal(await selected(),'460:8');
  const beforeZoom=(await metric()).pan;await $('#zoom-in').click();assert.notEqual((await metric()).pan,beforeZoom);
  const rect=await $('#viewport').boundingBox(), beforePan=(await metric()).pan;
  await page.mouse.move(rect.x+12,rect.y+35);await page.mouse.down();await page.mouse.move(rect.x+80,rect.y+75,{steps:7});await page.mouse.up();assert.notEqual((await metric()).pan,beforePan);
  await $('#fit').click();
  // Keep a real branch node under the pointer while zooming to the maximum.
  const decision = node('476:8');
  const original = await decision.boundingBox();
  const cursor = {x:original.x+original.width/2, y:original.y+original.height/2};
  await page.mouse.move(cursor.x,cursor.y);
  for(let i=0;i<7;i++)await page.mouse.wheel(0,-120);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#drawing')).zoom==='2.5');
  const enlarged = await decision.boundingBox();
  assert.ok(enlarged.width>original.width*2);
  assert.ok(Math.abs(enlarged.x+enlarged.width/2-cursor.x)<1);
  assert.ok(Math.abs(enlarged.y+enlarged.height/2-cursor.y)<1);
  assert.equal(await $('#scene').evaluate(e=>getComputedStyle(e).transform),'none');
  const alignment=await decision.evaluate(el=>{
    const path=document.querySelector('path[data-from="476:8"]');
    const start=path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
    const box=el.getBoundingClientRect();
    return {dx:start.x-(box.left+box.width/2),dy:start.y-box.bottom};
  });
  assert.ok(Math.abs(alignment.dx)<1&&Math.abs(alignment.dy)<1);
  await decision.locator('.node-main').click();assert.equal(await anchor(),'476');
  if(process.env.CODELENS_ZOOM_SCREENSHOT){
    const canvas=await $('#viewport').boundingBox();
    // Frame both branch labels in the 250% preview without changing zoom.
    await page.mouse.move(canvas.x+22,canvas.y+360);await page.mouse.down();
    await page.mouse.move(canvas.x+22,canvas.y+145,{steps:6});await page.mouse.up();
    await page.screenshot({path:process.env.CODELENS_ZOOM_SCREENSHOT});
  }
  await $('#fit').click();
  await $('#code-find').click();await $('#search-code').fill('ignore_index=-1, reduction=loss_reduction');await $('#search-code').press('Enter');
  assert.equal(await anchor(),'520');assert.equal(await selected(),'520:12');assert.match(await $('#note-text').textContent(),/B×T/);
  await $('#close-find').click();await $('#fold').click();assert.equal(await src(520).isVisible(),false);
  await nodeClick('520:12');assert.equal(await src(520).isVisible(),true);
  if(process.env.CODELENS_SCREENSHOT){await $('#reset').click();await page.screenshot({path:process.env.CODELENS_SCREENSHOT});}
  await $('#home').click();await file('nanochat/dataset.py');
  assert.equal(await $('#scopes').inputValue(),'download_single_file');
  await src(100).click();assert.match(await node('100:4').textContent(),/重试循环/);
  const retryEdges=await $('path.edge.back[data-to="100:4"]').count();assert.ok(retryEdges>0);
  await src(103).click();
  assert.ok(await $('path.edge.exception').count()>0);
  assert.ok((await $('[data-branch]').allTextContents()).some(t=>t.startsWith('except')));
  await $('#path-mode').selectOption('retry');assert.ok(await $('.node.subdued').count()>0);
  await $('#home').click();await file('scripts/base_train.py');
  assert.equal(await $('#scopes').inputValue(),'@focus');assert.equal(await anchor(),'416');
  await src(426).click();assert.equal(await selected(),'426:12');
  await page.evaluate(()=>document.querySelector('#source').scrollLeft=110);
  const exactPosition=await metric();
  await node('426:12').locator('[data-enter]').click();
  assert.equal(await $('#file-path').textContent(),'nanochat/loss_eval.py');
  assert.equal(await $('#scopes').inputValue(),'evaluate_bpb');assert.equal(await anchor(),'8');
  await $('#return').click();await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='scripts/base_train.py');
  assert.equal(await anchor(),'426');assert.equal(await selected(),'426:12');assert.deepEqual(await metric(),exactPosition);
  await page.reload();assert.equal(await anchor(),'426');assert.equal(await selected(),'426:12');
  await src(511).click();assert.equal(await selected(),'511:8');assert.match(await $('#note-text').textContent(),/未解析/);assert.equal(await node('511:8').locator('[data-enter]').count(),0);
  await $('#home').click();await file('nanochat/engine.py');await src(259).click();assert.match(await node('259:24').textContent(),/工具/);
  await page.setViewportSize({width:390,height:844});await $('#home').click();assert.equal(await $('#overview').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log('PASS offline HTML, summaries, source, horizontal layout, branches, loops, search, fold, zoom/pan, player, tool and call return.');
} finally {await browser.close();}
