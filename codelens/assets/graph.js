'use strict';
// Source-structured projection and CFG. No DOM or target-language execution.
const LensGraph = (() => {
  const W=182, H=70, DY=120, GAP=56, DX=36;
  const loopKinds=new Set(['For','AsyncFor','While']);
  const terminal={Return:'return', Raise:'raise', Break:'break', Continue:'continue'};
  const tryKind=s=>s.kind==='Try'||s.kind==='TryStar';
  const tool=c=>/(?:^|\.)(?:use_\w+|\w*tool\w*)$/i.test(c.name);
  const category=s=>loopKinds.has(s.kind)?'loop':s.kind==='If'||s.kind==='Match'?'decision':tryKind(s)?'try':
    terminal[s.kind]?'exit':s.symbol?'definition':s.calls.some(tool)?'tool':s.calls.length?'call':'action';
  function collect(steps, all=[], byId=new Map()) {
    for(const s of steps) {all.push(s);byId.set(s.id,s);for(const lane of s.lanes||[]) collect(lane.steps,all,byId);}
    return {all,byId};
  }
  function reachable(steps) {
    const out=new Set(); let live=true;
    for(const s of steps) {
      if(!live) break;
      const next=outcomes(s); for(const x of next) if(x!=='normal')out.add(x);
      live=next.has('normal');
    }
    if(live)out.add('normal'); return out;
  }
  function outcomes(s) {
    if(terminal[s.kind])return new Set([terminal[s.kind]]);
    if(!s.lanes?.length)return new Set(['normal']);
    const at=role=>reachable(s.lanes.find(l=>l.role===role)?.steps||[]);
    if(loopKinds.has(s.kind)) {
      const body=at('body'), out=new Set([...body].filter(x=>x==='return'||x==='raise'));
      if(!s.always) for(const x of at('else'))out.add(x);
      if(body.has('break'))out.add('normal');return out;
    }
    if(tryKind(s)) {
      const body=at('body'), fin=at('finally'), out=new Set([...body].filter(v=>v!=='normal'));
      if(body.has('normal'))for(const x of at('else'))out.add(x);
      for(const lane of s.lanes.filter(l=>l.role==='except'))for(const x of reachable(lane.steps))out.add(x);
      return new Set([...fin].flatMap(x=>x==='normal'?[...out]:[x]));
    }
    const out=new Set(s.lanes.flatMap(l=>[...reachable(l.steps)]));
    if(s.kind==='Match')out.add('normal'); return out;
  }
  function layout(raw, notes={}, expanded=new Map(), groups=[]) {
    const nodes=new Map(), edges=[], reveal=new Map(), points=[], regions=[];
    const note=id=>Object.hasOwn(notes,id)?notes[id]:null;
    const byFirst=new Map(groups.map(g=>[g.first,g]));
    function hide(children, id, path=[]) {
      for(const s of children) {reveal.set(s.id,[...path,id]);for(const l of s.lanes||[])hide(l.steps,id,path);}
    }
    function project(steps, depth, parents=[]) {
      let items=[], stash=[];
      const bulk=steps.length>8;
      function flush(semantic) {
        if(!stash.length)return;
        const group=stash;stash=[];
        const head=group[0], last=group.at(-1), id=`group:${head.id}:${last.id}`;
        if(group.length===1){items.push({s:head});return;}
        const prefix=semantic?.title||(group.every(s=>s.kind.startsWith('Import'))?'导入依赖':group.every(s=>s.symbol)?'定义类与函数':head.label);
        if(expanded.get(id)===true) {
          items.push(...group.map((s,i)=>({s, close:i===0?id:null}))); return;
        }
        hide(group,id,parents);
        items.push({s:{id,label:prefix,start:head.start,end:last.end,kind:'Group',calls:[],summary:semantic?.summary||`包含 ${group.length} 条相邻语句。展开可逐句查看。`},group});
      }
      for(let i=0;i<steps.length;i++) {
        const s=steps[i], semantic=byFirst.get(s.id);
        if(semantic) {
          const last=steps.findIndex((step,j)=>j>i&&step.id===semantic.last);
          if(last>i) {flush();stash=steps.slice(i,last+1);flush(semantic);i=last;continue;}
        }
        if(s.literal)continue;
        const important=s.lanes?.length||terminal[s.kind]||note(s.id)?.title||s.calls.some(c=>c.target&&c.target.path);
        if(important||!bulk) {flush();items.push({s});}
        else {stash.push(s);if(stash.length>=(steps.length>40?9:4))flush();}
      }
      flush();
      return items.map(item=>{
        const {s}=item;
        if(!item.group && !reveal.has(s.id))reveal.set(s.id,parents);
        if(!s.lanes?.length)return {...item,width:W};
        const defaultOpen=depth===0||(depth===1&&s.lanes.reduce((a,l)=>a+l.steps.length,0)<=3&&!s.lanes.some(l=>l.steps.some(x=>x.lanes?.length)));
        const open=expanded.get(s.id)??defaultOpen;
        if(!open) {
          for(const l of s.lanes)hide(l.steps,s.id,parents);
          return {...item,width:W,open:false};
        }
        const child=(lane)=>({...lane,block:plan(project(lane.steps,depth+1,[...parents,s.id]))});
        const lanes=s.lanes.map(child);
        const span=xs=>xs.reduce((sum,x)=>sum+x.block.width,0)+Math.max(0,xs.length-1)*GAP;
        if(loopKinds.has(s.kind))return {...item,open,lanes,width:Math.max(W,span(lanes))+104};
        if(tryKind(s)) {
          const body=lanes.find(l=>l.role==='body'), alt=lanes.filter(l=>l.role==='except');
          return {...item,open,lanes,width:Math.max(W,span([body,...alt].filter(Boolean)),...lanes.map(l=>l.block.width))+40};
        }
        const sides=s.kind==='Match'?[...lanes,{role:'no',label:'未匹配',block:plan([])}]:lanes;
        return {...item,open,lanes:sides,width:Math.max(W,span(sides))};
      });
    }
    function plan(items, pack=false){
      const rows=[];
      for(const item of items) {
        const chunk=rows.at(-1), ordinary=!item.s.lanes?.length&&!terminal[item.s.kind];
        if(pack&&ordinary&&chunk?.straight&&chunk.items.length<3)chunk.items.push(item);
        else rows.push({straight:ordinary,items:[item]});
      }
      return {items,rows,width:Math.max(W,...rows.map(r=>r.items.length===1?r.items[0].width:r.items.length*W+(r.items.length-1)*DX))};
    }
    function port(x,y) {const p={x,y};points.push(p);return p;}
    function node(s,x,y,item) {
      const isGroup=!!item.group, kind=isGroup?'group':category(s);
      const n={id:s.id,x,y,w:W,h:H,s,kind,title:note(s.id)?.title||s.label, note:note(s.id)?.summary||s.summary,
        toggle:item.close||((item.group||s.lanes?.length)?s.id:null), expanded:!!item.close||!!item.open, group:isGroup,
        count:item.group?.length||0,sources:item.group?.map(s=>s.id)||[]};
      nodes.set(n.id,n);points.push({x:x-W/2,y},{x:x+W/2,y:y+H});return n;
    }
    const up=n=>({x:n.x,y:n.y}), down=n=>({x:n.x,y:n.y+n.h}), left=n=>({x:n.x-n.w/2,y:n.y+n.h/2}), right=n=>({x:n.x+n.w/2,y:n.y+n.h/2});
    const exit=(n,kind='normal')=>({id:n.id,at:down(n),trail:[],kind});
    function route(a,b,via=[]) {
      if(via.length)return [a,...via,b];
      if(a.x===b.x)return [a,b];
      const half=(a.y+b.y)/2; return [a,{x:a.x,y:half},{x:b.x,y:half},b];
    }
    function send(from,target,opts={}) {
      if(!from?.id||!target?.id)return;
      const dest=opts.to||up(target), via=[...from.trail,...(opts.via||[])], before=via.at(-1);
      if(before&&before.x!==dest.x&&before.y!==dest.y)via.push({x:dest.x,y:before.y});
      const coords=route(from.at,dest,via);
      points.push(...coords);
      edges.push({from:from.id,to:target.id,coords,label:from.label||opts.label||'',labelAt:from.labelAt||opts.labelAt,
        kind:opts.kind||from.edge||'normal',back:!!opts.back,requires:opts.requires||from.requires||null,sets:opts.sets||from.sets||null});
    }
    const transit=(out,join,mid)=>( {...out,trail:[...out.trail,{x:mid??out.at.x,y:join.y},join]} );
    function pass(out,join) {
      const p=out.trail.at(-1)||out.at;return transit(out,join,p.x);
    }
    function fan(incoming,x,y,label,edge='branch') {
      const last=incoming.trail.at(-1)||incoming.at;
      const j=port(x,y-29), h=last.y+Math.max(12,(j.y-last.y)/2);
      return {...incoming,trail:[...incoming.trail,{x:last.x,y:h},{x,y:h},j],label,
        edge, labelAt:{x,y:y-12}};
    }
    function columns(xs,x) {
      const span=xs.reduce((sum,l)=>sum+l.block.width,0)+Math.max(0,xs.length-1)*GAP;
      let start=x-span/2;
      return xs.map(l=>{const m=start+l.block.width/2;start+=l.block.width+GAP;return {...l,x:m};});
    }
    function seq(block,x,y,entered,head=false) {
      let live=entered, abrupt=[], first=null, bottom=y;
      for(const row of block.rows) {
        const spread=row.items.length, width=spread*W+(spread-1)*DX;
        const x0=spread===1?x:x-(width-W)/2;
        if(spread>1)regions.push({x:x-width/2-12,y:y-10,w:width+24,h:H+20});
        for(const [i,item] of row.items.entries()) {
          const n=node(item.s,x0+i*(W+DX),y,item);first??=n;
          for(const o of live) {
            if(i>0) {
              const prior=nodes.get(o.id);
              send({...o,at:right(prior)},n,{to:left(n)});
            } else send(o,n);
          }
          const result=structure(item,n);
          if(live.length||head) {live=result.normal;abrupt.push(...result.abrupt);} else {n.unreachable=true;live=[];}
          head=false;bottom=result.bottom;
        }
        y=bottom+DY-H;
      }
      return {normal:live,abrupt,bottom,first};
    }
    function diverge(lanes,n,entries) {
      const yy=n.y+DY+10;
      return columns(lanes,n.x).map((lane,i)=>{
        const edge=entries[i]?.edge||'branch', label=entries[i]?.label||lane.label;
        const enter=fan(entries[i]||exit(n),lane.x,yy,label,edge);
        return {...seq(lane.block,lane.x,yy,[enter]),enter,lane};
      });
    }
    function structure(item,n) {
      const {s,lanes}=item, bottom=n.y+H;
      if(!item.open) {
        const result=outcomes(s), normal=result.has('normal')?[exit(n)]:[];
        const abrupt=[...result].filter(k=>k!=='normal').map(kind=>({...exit(n,kind),hidden:!!s.lanes?.length}));
        return {normal,abrupt,bottom};
      }
      if(loopKinds.has(s.kind)) {
        const body=lanes.find(l=>l.role==='body'), other=lanes.find(l=>l.role==='else');
        const yy=n.y+DY+10;
        const bx=other?columns([body,other],n.x)[0].x:n.x;
        const bodyIn=fan(exit(n),bx,yy,s.kind==='While'?(s.always?'循环体':'Yes'):'有下一项');
        const inside=seq(body.block,bx,yy,[bodyIn]);
        const leftX=n.x-item.width/2+15, rightX=n.x+item.width/2-15;
        const back=(o,label)=> {
          const p=o.trail.at(-1)||o.at, by=Math.max(p.y+14,inside.bottom+14);
          send(o,n,{label,kind:'back',back:true,to:left(n),via:[{x:p.x,y:by},{x:leftX,y:by},{x:leftX,y:n.y+H/2}]});
        };
        for(const o of inside.normal)back(o,'回环');
        for(const o of inside.abrupt.filter(o=>o.kind==='continue'))back(o,o.hidden?'continue 路径':'continue');
        const breakOut=inside.abrupt.filter(o=>o.kind==='break');
        const escape=inside.abrupt.filter(o=>o.kind!=='break'&&o.kind!=='continue');
        let exhausted=[], end=inside.bottom+40;
        if(!s.always) {
          const label=s.kind==='While'?'No':'已迭代完';
          const from={...exit(n),at:right(n),label,edge:'branch', labelAt:{x:rightX,y:n.y+H+14}};
          if(other) {
            const ox=columns([body,other],n.x)[1].x;
            const turn={x:rightX,y:n.y+H}, branch=fan({...from,at:turn},ox,yy,label);
            const enter={...branch,at:right(n),trail:[{x:rightX,y:n.y+H/2},turn,...branch.trail]};
            const otherwise=seq(other.block,ox,yy,[enter]);exhausted=otherwise.normal;escape.push(...otherwise.abrupt);end=Math.max(end,otherwise.bottom+36);
          } else exhausted=[{...from,trail:[{x:rightX,y:n.y+H/2},{x:rightX,y:end}]}];
        }
        const j=port(n.x,end);
        return {normal:[...exhausted,...breakOut.map(o=>({...o,kind:'normal',label:'break',edge:'branch'}))].map(o=>pass(o,j)),abrupt:escape,bottom:end};
      }
      if(tryKind(s)) {
        const main=lanes.find(l=>l.role==='body'), handlers=lanes.filter(l=>l.role==='except');
        const good=lanes.find(l=>l.role==='else'), cleanup=lanes.find(l=>l.role==='finally');
        const blocks=diverge([main,...handlers],n,[{...exit(n),label:'try'},...handlers.map(h=>({...exit(n),label:h.label,edge:'exception'}))]);
        let [body,...caught]=blocks, end=Math.max(bottom,...blocks.map(b=>b.bottom));
        if(good&&body.normal.length) {
          const clean=seq(good.block,body.lane.x,body.bottom+DY-H,body.normal.map(o=>({...o,label:o.label||'无异常'})));
          body={...clean,abrupt:[...body.abrupt,...clean.abrupt]};
          end=Math.max(end,body.bottom);
        }
        let normal=[...body.normal,...caught.flatMap(c=>c.normal)], abrupt=[...body.abrupt,...caught.flatMap(c=>c.abrupt)];
        if(cleanup) {
          const yy=end+DY-H+25, gateId=`finally:${s.id}`;
          const line=cleanup.line||cleanup.block.items[0]?.s.start||s.start;
          const gate=node({id:gateId,label:'finally',kind:'Finally',start:line,end:line,calls:[],summary:'离开 try 时先执行清理。'},n.x,yy,{});
          for(const o of normal)send(o,gate,{label:'finally',sets:`${s.id}:normal`});
          for(const o of abrupt)send(o,gate,{label:'先清理',kind:'exception',sets:`${s.id}:${o.kind}`});
          const fin=seq(cleanup.block,n.x,yy+DY,[exit(gate)]);
          if(fin.normal.length) {
            normal=normal.length?fin.normal.map(o=>({...o,requires:`${s.id}:normal`})):[];
            abrupt=[...new Set(abrupt.map(o=>o.kind))].flatMap(kind=>fin.normal.map(o=>({...o,kind,hidden:true,requires:`${s.id}:${kind}`})));
          } else {normal=[];abrupt=[];}
          abrupt.push(...fin.abrupt);end=fin.bottom;
        }
        const j=port(n.x,end+28);return {normal:normal.map(o=>pass(o,j)),abrupt,bottom:j.y};
      }
      if(s.kind==='If'||s.kind==='Match') {
        const entries=lanes.map(l=>({...exit(n),label:l.role==='yes'?'Yes':l.role==='no'?(s.kind==='Match'?'未匹配':'No'):l.label}));
        const blocks=diverge(lanes,n,entries), j=port(n.x,Math.max(bottom,...blocks.map(b=>b.bottom))+28);
        return {normal:blocks.flatMap(b=>b.normal).map(o=>pass(o,j)),abrupt:blocks.flatMap(b=>b.abrupt),bottom:j.y};
      }
      const inner=seq(lanes[0].block,n.x,n.y+DY,[exit(n)]);
      return {normal:inner.normal,abrupt:inner.abrupt,bottom:inner.bottom};
    }
    const main=seq(plan(project(raw,0),true),0,36,[],true);
    if(main.normal.some(o=>o.label)&&main.first) {
      const end=node({id:'@end',label:'结束当前范围',kind:'Return',synthetic:true,calls:[],summary:'已走到所选范围末尾。'},0,main.bottom+DY-H,{});
      for(const o of main.normal)send(o,end);
    }
    const box=points.reduce((b,p)=>({left:Math.min(b.left,p.x-42),right:Math.max(b.right,p.x+42),top:0,bottom:Math.max(b.bottom,p.y+42)}),{left:-150,right:150,top:0,bottom:180});
    const links=new Map();
    edges.forEach((e,i)=>{e.id=i;if(!links.has(e.from))links.set(e.from,[]);links.get(e.from).push(e);});
    return {nodes,edges,reveal,box,links,regions,entry:main.first?.id};
  }
  function geometry(coords) {
    const pts=coords.filter((p,i)=>!i||p.x!==coords[i-1].x||p.y!==coords[i-1].y);
    if(!pts.length)return '';
    let d=`M${pts[0].x},${pts[0].y}`;
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i],c=pts[i+1];
      if(!c) {d+=`L${b.x},${b.y}`;continue;}
      const p=Math.hypot(b.x-a.x,b.y-a.y),q=Math.hypot(c.x-b.x,c.y-b.y),r=Math.min(10,p/2,q/2);
      d+=`L${b.x+(a.x-b.x)*r/p},${b.y+(a.y-b.y)*r/p}Q${b.x},${b.y} ${b.x+(c.x-b.x)*r/q},${b.y+(c.y-b.y)*r/q}`;
    }
    return d;
  }
  return {layout,collect,geometry};
})();
