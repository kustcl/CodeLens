// Runs against the actual standalone TypeScript demo, in an offline browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = path.resolve(process.argv[2] ?? path.join(root,'output/typescript.html'));
const demo = path.join(root,'examples/typescript-demo');
const moduleName = process.env.PLAYWRIGHT_MODULE;
const {chromium} = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
const browser = await chromium.launch(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {});
const page = await browser.newPage({viewport:{width:1440,height:900},offline:true});
page.setDefaultTimeout(5000);
const errors=[], requests=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
const $=selector=>page.locator(selector);
const node=id=>$(`.node[data-node="${id}"]`);
const sourceLine=line=>$(`.code-row[data-line="${line}"] .line-button`);
const anchor=()=>$('.code-row.anchor').getAttribute('data-line');
const selected=()=>$('.node.selected').getAttribute('data-node');
const camera=()=>$('#scene').evaluate(e=>e.style.cssText);
async function open(file){await $('#search-files').fill(file);await $(`button[data-path="${file}"]`).click();}
async function exactSource(file){
  const source=fs.readFileSync(path.join(demo,file),'utf8').replace(/\r\n?/g,'\n').replace(/\n$/,'');
  assert.deepEqual(await $('.src').allTextContents(),source.split('\n'));
  assert.deepEqual(await $('.line-button').allTextContents(),source.split('\n').map((_,i)=>String(i+1)));
}
try{
  await page.goto(pathToFileURL(html).href);
  assert.equal(await $('#project').textContent(),'typescript-demo');
  assert.equal(await $('#overview').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  await open('src/main.ts');
  await exactSource('src/main.ts');
  assert.equal(await $('#source').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(21, 25, 31)');
  assert.equal(await $('#viewport').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  assert.equal(await $('#scopes').inputValue(),'main');
  assert.equal(await selected(),'6:2');
  assert.ok(await $('.src .kw').count()>0);
  await $('#next').click();assert.equal(await anchor(),'7');
  await $('#prev').click();assert.equal(await anchor(),'6');
  await sourceLine(8).click();assert.equal(await selected(),'8:4');
  await node('8:4').locator('.node-main').click();assert.equal(await anchor(),'8');
  await $('[data-branch="Yes"]').first().click();assert.equal(await anchor(),'9');
  assert.ok(await $('path.edge.back[data-to="7:2"]').count()>0);
  if(process.env.CODELENS_TS_SCREENSHOT)await page.screenshot({path:process.env.CODELENS_TS_SCREENSHOT});
  await sourceLine(12).click();assert.equal(await selected(),'12:6');
  assert.ok(await $('path.edge.exception').count()>0);
  assert.match((await $('[data-branch]').allTextContents()).join(' '),/catch \(error\)/);
  const oldCamera=await camera();
  await node('12:6').locator('[data-enter]').click();
  assert.equal(await $('#file-path').textContent(),'src/score.ts');assert.equal(await $('#scopes').inputValue(),'normalize');
  assert.equal(await anchor(),'7');await exactSource('src/score.ts');
  await $('#return').click();await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='src/main.ts');
  assert.equal(await anchor(),'12');assert.equal(await selected(),'12:6');assert.equal(await camera(),oldCamera);
  await sourceLine(17).click();assert.equal(await selected(),'17:6');assert.equal(await node('17:6').locator('[data-enter]').count(),0);
  assert.match(await $('#note-text').textContent(),/未解析调用/);
  await $('#home').click();await open('src/badge.tsx');await exactSource('src/badge.tsx');
  await $('#scopes').selectOption('ScoreBadge');
  assert.equal(await $('.code-row[data-line="6"] .kw').allTextContents().then(a=>a.filter(x=>x==='span').length),2);
  await $('#fold').click();assert.equal(await sourceLine(6).isVisible(),false);
  await node('6:2').locator('.node-main').click();assert.equal(await anchor(),'6');assert.equal(await sourceLine(6).isVisible(),true);
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  console.log('PASS offline TypeScript/TSX source, syntax, loop, branches, exception, two-way sync, alias call/return and fold');
}finally{await browser.close();}