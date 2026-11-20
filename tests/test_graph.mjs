import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const graph = vm.runInNewContext(readFileSync(new URL('../codelens/assets/graph.js', import.meta.url),'utf8')+'\nLensGraph');
const op=(id,kind='Expr',lanes)=>({id:String(id),label:`${kind} ${id}`,start:id,end:id,calls:[],kind,lanes});
const lane=(role,...steps)=>({role,label:role,steps});
const edge=(g,a,b)=>g.edges.find(e=>e.from===String(a)&&e.to===String(b));

test('packs consecutive actions into a horizontal band, then fans out and merges',()=>{
  const g=graph.layout([op(1),op(2),op(3,'If',[lane('yes',op(4)),lane('no',op(5))]),op(6)]);
  assert.equal(g.nodes.get('1').y,g.nodes.get('2').y);
  assert.ok(g.nodes.get('1').x<g.nodes.get('2').x);
  assert.ok(g.nodes.get('4').x<g.nodes.get('5').x);
  assert.equal(edge(g,3,4).label,'Yes');assert.equal(edge(g,3,5).label,'No');
  assert.ok(edge(g,4,6)&&edge(g,5,6));
});

test('loop distinguishes exhaustion, continue and break and never follows return',()=>{
  const g=graph.layout([op(1,'For',[lane('body',op(2,'If',[lane('yes',op(3,'Continue')),lane('no')]),op(4,'If',[lane('yes',op(5,'Break')),lane('no')]),op(6)),lane('else',op(7))]),op(8,'Return'),op(9)]);
  assert.equal(edge(g,3,1).back,true);assert.equal(edge(g,6,1).back,true);
  assert.equal(edge(g,1,7).label,'已迭代完');assert.ok(edge(g,7,8));assert.equal(edge(g,5,7),undefined);assert.ok(edge(g,5,8));
  assert.equal(edge(g,8,9),undefined);
  const endless={...op(11,'While',[lane('body',op(12))]),always:true};
  const x=graph.layout([endless,op(13)]);
  assert.ok(edge(x,12,11));assert.equal(edge(x,11,13),undefined);
});

test('bare if branches stay selectable when the scope immediately ends',()=>{
  const g=graph.layout([op(1,'If',[lane('yes',op(2,'Return')),lane('no')])]);
  assert.equal(edge(g,1,'@end').label,'No');assert.equal(edge(g,1,2).label,'Yes');
});

test('try draws a separate exception path and finally does not imply fallthrough for return',()=>{
  const g=graph.layout([op(1,'Try',[lane('body',op(2,'If',[lane('yes',op(3,'Return')),lane('no')]),op(4)),lane('except',op(5)),lane('else',op(6)),{...lane('finally',op(8)),line:7}]),op(9)]);
  assert.ok(edge(g,1,5).kind==='exception');assert.ok(edge(g,4,6));assert.equal(edge(g,5,6),undefined);
  assert.equal(g.nodes.get('finally:1').s.start,7);
  assert.equal(edge(g,3,'finally:1').sets,'1:return');assert.equal(edge(g,6,'finally:1').sets,'1:normal');
  assert.equal(edge(g,8,9).requires,'1:normal');
});

test('semantic grouping is reversible and reveal keeps raw statement mapping',()=>{
  const raw=[op(3),op(4),op(5),op(6,'Return')], groups=[{first:'3',last:'5',title:'Read then normalize'}];
  const g=graph.layout(raw,{},new Map(),groups);
  assert.equal(g.nodes.get('group:3:5').title,'Read then normalize');assert.equal(g.reveal.get('4').includes('group:3:5'),true);
  const ex=graph.layout(raw,{},new Map([['group:3:5',true]]),groups);
  assert.ok(ex.nodes.has('4'));assert.ok(edge(ex,3,4)&&edge(ex,4,5)&&edge(ex,5,6));
});
