'use strict';
(() => {
  const $=id=>document.getElementById(id), D=JSON.parse($('model-data').textContent), MODULE='(module)', FOCUS='@focus';
  const files=D.files, own=(o,k)=>Object.hasOwn(o,k), sessions=new Map();
  const icons={folder:'M2.5 4h4l1.5 2H14v7H2.5z',file:'M4 2.5h5l3 3V14H4z M9 2.5v3h3',source:'M4 2.5h5l3 3V14H4z M9 2.5v3h3 M6 8l-1 1.5L6 11m4-3 1 1.5L10 11'};
  const labels={action:'操作',call:'调用',tool:'工具候选',loop:'循环',decision:'判断',try:'异常处理',exit:'退出',group:'代码组',definition:'定义'};
  const viewport=$('viewport'), scene=$('scene'), source=$('source');
  let current=null, rows=[], folds=new Set(), activeRows=[], searchLines=[], searchIndex=-1, timer=null, foundLine=0, lastHash=null, drag=null, skipClick=false;
  let camera={x:0,y:0,z:1}, nodeEls=new Map(), edgeEls=new Map();
  const svgNS='http://www.w3.org/2000/svg';
  const E=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  const S=(tag,attrs)=>{const e=document.createElementNS(svgNS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);return e;};
  function button(text,fn,cls,title) {const b=E('button',cls,text);b.type='button';if(title){b.title=title;b.setAttribute('aria-label',title);}b.addEventListener('click',fn);return b;}
  const lineTag=(a,b=a)=>a===b?`L${a}`:`L${a}–${b}`;
  const split=(text,language)=>{
    const breaks=language==='typescript'?/[\n\u2028\u2029]/:/\n/;
    return text?(breaks.test(text.at(-1))?text.slice(0,-1):text).split(breaks):[];
  };
  const option=(text,value)=>{const o=E('option','',text);o.value=value;return o;};
  function icon(key) {const svg=S('svg',{class:'tree-ico',viewBox:'0 0 16 16','aria-hidden':'true'});svg.append(S('path',{d:icons[key]}));return svg;}

  const treeRoot={children:[],path:''}, treeDirs=new Map([['',treeRoot]]);
  for(const item of D.tree) {
    const i=item.path.lastIndexOf('/'), itemNode={...item,name:item.path.slice(i+1),children:[]};
    treeDirs.get(i<0?'':item.path.slice(0,i))?.children.push(itemNode);
    if(item.kind==='directory')treeDirs.set(item.path,itemNode);
  }
  const languages={python:'Python',typescript:'TypeScript'};
  const fileFor=node=>own(files,node.path)?files[node.path]:null;
  const important=node=>{const f=fileFor(node);return !!(f?.key||f?.role==='入口候选'||f?.entry.length||node.key);};
  function summary(node) {
    const f=fileFor(node);
    if(f) return (f.annotated?f.summary:f.summary.split(' · ')[0]).replace(/\s+/g,' ').slice(0,115);
    if(node.summary)return node.summary;
    if(node.kind==='directory')return '';
    if(own(languages,node.kind))return `${languages[node.kind]} 源文件`;
    const ext=node.name.split('.').at(-1).toLowerCase();
    return ({md:'项目文档',rst:'项目文档',toml:'项目配置',yaml:'配置文件',yml:'配置文件',json:'结构化数据',txt:'文本文件',sh:'运行脚本',ipynb:'交互式笔记本',png:'图像资源',svg:'图像资源',lock:'依赖锁定文件'})[ext]||'项目文件';
  }
  const firstDirs=[...treeRoot.children].filter(n=>n.kind==='directory'&&n.children.some(important)).slice(0,2).map(n=>n.path);
  const openDirs=new Set(firstDirs);
  function drawTree() {
    const query=$('search-files').value.trim().toLowerCase();
    function visit(parent,depth,ancestorMatch=false) {
      const fragment=document.createDocumentFragment();
      const sorted=[...parent.children].sort((a,b)=>(a.kind!=='directory')-(b.kind!=='directory')||a.name.localeCompare(b.name));
      for(const node of sorted) {
        const dir=node.kind==='directory', hit=!query||ancestorMatch||`${node.path} ${summary(node)}`.toLowerCase().includes(query);
        const child=dir?visit(node,depth+1,ancestorMatch||(!!query&&hit)):null;
        if(!hit&&!child?.childNodes.length)continue;
        const f=fileFor(node), row=dir?E('summary','tree-row'):f?button('',()=>navigate(node.path),'tree-row source-file'):E('div','tree-row');
        row.dataset.path=node.path;row.style.setProperty('--depth',depth);
        const name=E('span','name');
        name.append(E('span','chev',dir?'›':''),icon(dir?'folder':own(languages,node.kind)?'source':'file'),E('span','',node.name+(dir?'/':'')));
        if(important(node)){const mark=E('i','important');mark.title='关键文件';name.append(mark);}
        const desc=E('span','desc',summary(node));
        if(node.status)desc.append(E('span','status',node.status));
        row.append(name,desc);row.title=node.path;
        if(dir){const details=E('details'), children=E('div','tree-children');
          children.style.setProperty('--depth',depth);children.append(child);
          details.open=query?true:openDirs.has(node.path);details.append(row,children);
          details.addEventListener('toggle',()=>{if(!query){if(details.open)openDirs.add(node.path);else openDirs.delete(node.path);}});fragment.append(details);
        }else fragment.append(row);
      }
      return fragment;
    }
    const body=visit(treeRoot,0);
    $('tree').replaceChildren(body.childNodes.length?body:E('p','tree-empty',query?'未找到匹配的文件。':'没有可展示的项目文件。'));
  }
  $('project').textContent=D.name;$('description').textContent=D.description||'浏览项目文件，点击源码开始探索。';
  if(D.warnings.length){$('catalog-warning').hidden=false;$('catalog-warning').textContent='少量路径读取失败，详情见分析数据。';}
  $('search-files').addEventListener('input',drawTree);$('search-files').addEventListener('keydown',e=>{if(e.key==='Enter')$('tree').querySelector('button.tree-row')?.click();});
  drawTree();

  function renderSource(file){
    rows=[];activeRows=[];folds=new Set();foundLine=0;
    const symbols=new Map(file.symbols.filter(s=>s.end>s.start).map(s=>[s.start,s]));
    const table=E('div','code-table');
    source.setAttribute('aria-label',`完整 ${languages[file.language]||''} 源码`);
    split(file.source,file.language).forEach((text,index)=>{
      const n=index+1, row=E('div','code-row'), gutter=E('div','gutter'), cell=E('div','cell'), code=E('code','src');
      row.dataset.line=n;
      if(symbols.has(n)){
        const s=symbols.get(n), toggle=E('button','fold-toggle','▾');toggle.type='button';toggle.dataset.fold=s.id;gutter.append(toggle);
      }
      const line=E('button','line-button',n);line.type='button';line.setAttribute('aria-label',`第 ${n} 行`);gutter.append(line);
      let i=0;for(const [a,b,type] of file.syntax?.[n]||[]){if(a<i)continue;if(a>i)code.append(document.createTextNode(text.slice(i,a)));code.append(E('span',type,text.slice(a,b)));i=b;}
      if(i<text.length)code.append(document.createTextNode(text.slice(i)));
      cell.append(code);row.append(gutter,cell);table.append(row);rows.push(row);
    });
    source.replaceChildren(rows.length?table:E('p','tree-empty','此文件为空。'));
    const options=[option('文件级流程',MODULE)];
    if(file.focus?.node)options.unshift(option(file.focus.label||'重点流程',FOCUS));
    for(const s of file.symbols)options.push(option(`${s.name} · L${s.line}`,s.id));
    $('scopes').replaceChildren(...options);$('fold').disabled=!symbols.size;source.scrollTop=0;source.scrollLeft=0;
    $('search-code').value='';$('find-code').hidden=true;searchLines=[];searchIndex=-1;$('match-count').textContent='';
    paintFolds();
  }
  function paintFolds(){
    const closed=new Map(current.file.symbols.filter(s=>folds.has(s.id)).map(s=>[s.start,s.end]));let end=0;
    rows.forEach((r,i)=>{const n=i+1;r.hidden=n<=end;if(closed.has(n))end=Math.max(end,closed.get(n));});
    for(const toggle of source.querySelectorAll('.fold-toggle')){
      const fold=folds.has(toggle.dataset.fold);toggle.textContent=fold?'▸':'▾';toggle.setAttribute('aria-label',`${fold?'展开':'折叠'} ${toggle.dataset.fold}`);toggle.setAttribute('aria-expanded',String(!fold));
      const r=toggle.closest('.code-row'), cell=r.lastElementChild;cell.querySelector('.fold-stub')?.remove();if(fold)cell.append(E('span','fold-stub',`… ${lineTag(Number(r.dataset.line),closed.get(Number(r.dataset.line)))}`));
    }
    $('fold').textContent=folds.size?'展开':'折叠';
  }
  function sourceLine(line,first=line,last=line,scroll=true){
    for(const r of activeRows)r.classList.remove('active','anchor');activeRows=[];
    if(!line||!rows.length)return;
    if(rows[line-1]?.hidden){for(const s of current.file.symbols)if(s.start<line&&line<=s.end)folds.delete(s.id);paintFolds();}
    for(let i=first;i<=Math.min(last,rows.length);i++){const r=rows[i-1];if(r){r.classList.add('active');activeRows.push(r);}}
    const anchor=rows[line-1];if(!anchor)return;
    anchor.classList.add('anchor');if(!activeRows.includes(anchor))activeRows.push(anchor);
    if(scroll){const a=anchor.getBoundingClientRect(), view=source.getBoundingClientRect();const wanted=view.top+Math.min(source.clientHeight*.28,165);source.scrollTop+=a.top-wanted;}
  }
  function displaySearch(show){$('find-code').hidden=!show;if(show)$('search-code').focus();else{$('search-code').value='';findMatches();}}
  function findMatches(){
    for(const line of searchLines)rows[line-1]?.classList.remove('match','found');
    const query=$('search-code').value.trim().toLowerCase();searchLines=[];searchIndex=-1;foundLine=0;
    if(query)rows.forEach((r,i)=>{if(r.querySelector('.src').textContent.toLowerCase().includes(query)){searchLines.push(i+1);r.classList.add('match');}});
    $('match-count').textContent=query?(searchLines.length?String(searchLines.length):'0'):'';
  }
  function findStride(delta){
    if(!searchLines.length)return;rows[foundLine-1]?.classList.remove('found');searchIndex=searchIndex===-1?(delta>0?0:searchLines.length-1):(searchIndex+delta+searchLines.length)%searchLines.length;
    foundLine=searchLines[searchIndex];rows[foundLine-1]?.classList.add('found');$('match-count').textContent=`${searchIndex+1}/${searchLines.length}`;selectLine(foundLine,true);
  }
  $('code-find').onclick=()=>displaySearch($('find-code').hidden);$('close-find').onclick=()=>displaySearch(false);
  $('search-code').oninput=findMatches;$('search-code').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();findStride(e.shiftKey?-1:1);}if(e.key==='Escape')displaySearch(false);};
  $('match-prev').onclick=()=>findStride(-1);$('match-next').onclick=()=>findStride(1);
  source.addEventListener('click',e=>{
    const toggle=e.target.closest('.fold-toggle');if(toggle){const id=toggle.dataset.fold;if(folds.has(id))folds.delete(id);else folds.add(id);paintFolds();return;}
    const row=e.target.closest('.code-row');if(row&&(e.target.classList.contains('line-button')||window.getSelection()?.isCollapsed))selectLine(Number(row.dataset.line),false);
  });
  $('fold').onclick=()=>{folds=folds.size?new Set():new Set(current.file.symbols.filter(s=>s.end>s.start).map(s=>s.id));paintFolds();};

  function getSession(file,scope){
    const key=JSON.stringify([file.path,scope]);
    if(sessions.has(key))return sessions.get(key);
    const inner=scope===FOCUS?file.focus.scope:scope, all=file.flows[inner]||[];
    const focus=scope===FOCUS?LensGraph.collect(all).byId.get(file.focus.node):null, raw=focus?[focus]:all;
    const s={key,file,scope,inner,focus,raw,index:LensGraph.collect(raw),expanded:new Map(),notes:file.notes&&own(file.notes,inner)?file.notes[inner].steps:{},groups:file.notes?.[inner]?.groups||[],graph:null,
      mode:'all',route:null,visits:new Set(), edges:new Set(), trail:[], active:null, line:null, flags:{}, loops:{}, camera:null, scroll:null};
    sessions.set(key,s);return s;
  }
  function paintCamera(){
    // Pan in screen pixels, zoom the drawing at layout size. Do not force a
    // composited transform layer that can magnify pre-rasterized node text.
    const dpr=window.devicePixelRatio||1;
    scene.style.left=`${Math.round(camera.x*dpr)/dpr}px`;
    scene.style.top=`${Math.round(camera.y*dpr)/dpr}px`;
    const scale=String(camera.z);
    if(scene.style.getPropertyValue('--graph-scale')!==scale)scene.style.setProperty('--graph-scale',scale);
  }
  function fit(){
    const g=current?.graph;if(!g?.entry)return;
    const ratio=(viewport.clientWidth-28)/(g.box.right-g.box.left);
    const z=Math.max(.58,Math.min(1.1,ratio));camera={x:viewport.clientWidth/2-(g.box.left+g.box.right)*z/2,y:14,z};paintCamera();
  }
  function center(n,force=false){
    if(!n)return;
    const w=viewport.clientWidth,h=viewport.clientHeight,z=camera.z, a=n.x*z+camera.x,b=n.y*z+camera.y;
    if(force||a-n.w*z/2<18||a+n.w*z/2>w-18)camera.x=w/2-n.x*z;
    if(force||b<28||b+n.h*z>h-42)camera.y=Math.min(h*.26,144)-n.y*z;
    paintCamera();
  }
  function zoom(delta,x=viewport.clientWidth/2,y=viewport.clientHeight/2){
    if(!current?.graph?.entry)return;
    const z=Math.min(2.5,Math.max(.35,camera.z*delta));camera={x:x-(x-camera.x)*z/camera.z,y:y-(y-camera.y)*z/camera.z,z};paintCamera();hideGesture();
  }
  const hideGesture=()=>$('gesture-hint').classList.add('off');
  $('fit').onclick=()=>{fit();const n=current?.graph?.nodes.get(current.active);if(n)center(n);};
  $('zoom-out').onclick=()=>zoom(.82);$('zoom-in').onclick=()=>zoom(1.22);
  viewport.addEventListener('wheel',e=>{if(!current?.graph?.entry)return;e.preventDefault();const rect=viewport.getBoundingClientRect();zoom(Math.exp(Math.max(-120,Math.min(120,-e.deltaY))*.002),e.clientX-rect.left-viewport.clientLeft,e.clientY-rect.top-viewport.clientTop);},{passive:false});
  viewport.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button'))return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,from:{...camera},moved:false};viewport.setPointerCapture(e.pointerId);});
  viewport.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;const x=e.clientX-drag.x,y=e.clientY-drag.y;if(!drag.moved&&Math.hypot(x,y)<4)return;drag.moved=true;viewport.classList.add('drag');camera.x=drag.from.x+x;camera.y=drag.from.y+y;paintCamera();hideGesture();});
  function stopDrag(){if(drag?.moved){skipClick=true;setTimeout(()=>{skipClick=false;},0);}drag=null;viewport.classList.remove('drag');}
  viewport.addEventListener('pointerup',stopDrag);viewport.addEventListener('pointercancel',stopDrag);viewport.addEventListener('lostpointercapture',stopDrag);
  viewport.onkeydown=e=>{if(e.target!==viewport)return;const dir={ArrowLeft:[45,0],ArrowRight:[-45,0],ArrowUp:[0,45],ArrowDown:[0,-45]}[e.key];if(dir){e.preventDefault();camera.x+=dir[0];camera.y+=dir[1];paintCamera();}else if(e.key==='+'||e.key==='-'){e.preventDefault();zoom(e.key==='+'?1.2:.83);}};
  new ResizeObserver(()=>{if(current?.active)center(current.graph?.nodes.get(current.active));else if(current)fit();}).observe(viewport);

  const edgeKey=e=>JSON.stringify([e.from,e.to,e.label,e.kind,e.requires,e.sets]);
  function makeGraph(){return LensGraph.layout(current.raw,current.notes,current.expanded,current.groups);}
  function ensureGraph(rawId){
    current.graph??=makeGraph();
    for(let budget=0;rawId&&!current.graph.nodes.has(rawId)&&budget<20;budget++) {
      const toExpand=current.graph.reveal.get(rawId);if(!toExpand?.length||toExpand.every(id=>current.expanded.get(id)===true))break;
      for(const id of toExpand)current.expanded.set(id,true);
      current.graph=makeGraph();
    }
  }
  function enteredTargets(n){
    const map=new Map();for(const c of n.s.calls)if(c.target)map.set(JSON.stringify(c.target),c);return [...map.values()];
  }
  function drawGraph(){
    const g=current.graph, svg=$('edges'), layer=$('node-layer');nodeEls=new Map();edgeEls=new Map();svg.replaceChildren();layer.replaceChildren();
    $('graph-empty').hidden=!!g.entry;$('graph-empty').textContent=!g.entry?(current.file.error||'这个范围没有可绘制的执行语句。'):'';
    const defs=S('defs',{});
    for(const [k,fill] of Object.entries({normal:'#64748a',exception:'#796399',back:'#4d7975',visited:'#2663a2'})){
      const mark=S('marker',{id:`tip-${k}`,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});
      mark.append(S('path',{d:'M 0 0 L 10 5 L 0 10 Z',fill}));defs.append(mark);
    }
    svg.append(defs);
    for(const r of g.regions)svg.append(S('rect',{class:'flow-region',x:r.x,y:r.y,width:r.w,height:r.h,rx:12}));
    const modes=[['全部流向','all']];
    if(g.edges.some(e=>e.label==='Yes'))modes.push(['Yes 分支','yes']);
    if(g.edges.some(e=>e.label==='No'))modes.push(['No 分支','no']);
    if([...g.nodes.values()].some(n=>n.s.kind==='Return'&&!n.s.synthetic))modes.push(['返回路径','return']);
    if(g.edges.some(e=>e.kind==='exception'||e.kind==='back'))modes.push(['异常 / 回环','retry']);
    if([...g.nodes.values()].some(n=>n.kind==='tool'))modes.push(['工具调用','tool']);
    $('path-mode').replaceChildren(...modes.map(([text,value])=>option(text,value)));
    if(!modes.some(([,value])=>value===current.mode))current.mode='all';
    $('path-mode').value=current.mode;deriveRoute();
    const labelClaims=new Set();
    for(const e of g.edges){
      const kind=['exception','back'].includes(e.kind)?e.kind:'normal';
      const path=S('path',{class:`edge ${e.kind}`,d:LensGraph.geometry(e.coords),'marker-end':`url(#tip-${kind})`,'data-edge':e.kind,'data-from':e.from,'data-to':e.to});svg.append(path);
      let tag=null;
      if(e.label){
        const a=e.coords[0], b=e.coords[1]||a, spot=e.labelAt||{x:(a.x+b.x)/2+24,y:(a.y+b.y)/2};
        const signature=JSON.stringify([spot.x,spot.y,e.label]);
        if(!labelClaims.has(signature)){
          labelClaims.add(signature);tag=button(e.label,()=>{if(!skipClick)chooseEdge(e);},`edge-label ${e.kind}`,`探索 ${e.label}`);
          tag.style.left=`${spot.x}px`;tag.style.top=`${spot.y}px`;tag.dataset.branch=e.label;layer.append(tag);
        }
      }
      edgeEls.set(edgeKey(e),{path,tag,kind});
    }
    for(const n of g.nodes.values()){
      const box=E('div',`node ${n.kind}${n.unreachable?' unreachable':''}`);box.dataset.node=n.id;box.style.cssText=`left:${n.x-n.w/2}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;`;
      if(n.kind==='decision') {
        const diamond=S('svg',{class:'diamond',viewBox:'0 0 182 70',preserveAspectRatio:'none','aria-hidden':'true'});
        diamond.append(S('path',{d:'M 86 3 Q 91 1 96 3 L 176 32 Q 182 35 176 38 L 96 67 Q 91 69 86 67 L 6 38 Q 0 35 6 32 Z'}));box.append(diamond);
      }
      const main=button('',()=>{if(!skipClick)activate(n.id,{manual:true});},'node-main');
      main.title=`${n.title}${n.s.synthetic?'':` · ${lineTag(n.s.start,n.s.end)}`}`;
      const meta=E('span','node-meta'), title=E('span','node-title',n.title);
      const tag=n.s.retry?'重试循环候选':n.s.synthetic?'静态终点':labels[n.kind];
      meta.append(E('span','',tag));if(!n.s.synthetic)meta.append(E('span','',lineTag(n.s.start,n.s.end)));
      main.append(meta,title);box.append(main);
      const tools=E('div','node-actions'), targets=enteredTargets(n);
      if(n.toggle){const t=button(n.expanded?'−':'+',()=>toggle(n),'',n.expanded?'折叠局部流程':'展开局部流程');t.dataset.toggle=n.toggle;t.setAttribute('aria-expanded',String(n.expanded));tools.append(t);}
      if(n.s.symbol||targets.length===1){const t=button('↗',()=>n.s.symbol?navigate(current.file.path,n.s.symbol,{},'call'):jump(targets[0].target),'',n.s.symbol?`进入定义 ${n.s.symbol}`:`进入函数 ${targets[0].target.symbol}`);t.dataset.enter='';tools.append(t);}
      if(tools.childNodes.length)box.append(tools);layer.append(box);nodeEls.set(n.id,{box,main});
    }
  }
  function drawState(){
    for(const [id,e] of nodeEls){e.box.classList.toggle('subdued',!!current.route&&!current.route.nodes.has(id)&&id!==current.active);e.box.classList.toggle('selected',id===current.active);e.box.classList.toggle('visited',current.visits.has(id));if(id===current.active)e.main.setAttribute('aria-current','step');else e.main.removeAttribute('aria-current');}
    for(const [id,e] of edgeEls){const route=current.route, onRoute=route?.ids.has(id);const v=current.edges.has(id)||onRoute;e.path.classList.toggle('subdued',!!route&&!onRoute&&!current.edges.has(id));e.tag?.classList.toggle('subdued',!!route&&!onRoute&&!current.edges.has(id));e.path.classList.toggle('visited',!!v);e.path.setAttribute('marker-end',`url(#tip-${v?'visited':e.kind})`);e.tag?.classList.toggle('visited',!!v);}
    const n=current.graph?.nodes.get(current.active), node=n?.s, targets=n&&enteredTargets(n), footer=$('call-actions');footer.replaceChildren();
    const line=current.line||node?.start;
    $('note-line').textContent=line?(node&&!node.synthetic?lineTag(node.start,node.head||node.end):lineTag(line)):'';
    let note=n?.note||(!current.graph?.entry?'暂无流程':line?'此行没有单独的流程节点。':'点击节点探索源码。');
    if(node?.calls?.some(c=>!c.target))note+=' · 含未解析调用';
    $('note-title').textContent=n?.title||'';$('note-text').textContent=note;$('note-text').title=note;
    if(targets?.length)for(const c of targets.slice(0,6))footer.append(button(`进入 ${c.target.symbol}${c.status==='candidate'?'（候选）':''} ↗`,()=>jump(c.target),'text-link',`打开 ${c.target.path}:${c.target.line} ${c.target.symbol}`));
    if(n?.s.symbol)footer.append(button(`进入 ${n.s.symbol} ↗`,()=>navigate(current.file.path,n.s.symbol,{},'call'),'text-link'));
    $('prev').disabled=!current.trail.length;$('next').disabled=current.active?!options().length:!current.graph?.entry;$('play').disabled=!timer&&$('next').disabled;$('reset').disabled=!current.graph?.entry;
  }
  function toggle(n){
    pause();const centerBefore=n.y*camera.z+camera.y;
    current.expanded.set(n.toggle,!n.expanded);current.graph=makeGraph();drawGraph();
    let target=current.graph.nodes.get(n.id);
    if(!target){const bySource=rawAt(n.s.start);target=current.graph.nodes.get(bySource?.id)||[...current.graph.nodes.values()].find(q=>q.sources.includes(n.s.id));}
    if(target){camera.y=centerBefore-target.y*camera.z;paintCamera();activate(target.id,{manual:true,centerNode:false});}
    else drawState();
  }
  function rawAt(line){
    let best=null;for(const s of current.index.all){if(s.literal||s.start>line||s.end<line)continue;if(!best||s.end-s.start<=best.end-best.start)best=s;}return best;
  }
  function selectLine(line,scroll){
    pause();
    const file=current.file;
    const scopes=file.symbols.filter(s=>s.start<=line&&s.end>=line);
    let best=null;for(const s of scopes)if(!best||s.end-s.start<=best.end-best.start)best=s;
    const stay=current.scope===FOCUS&&line>=current.focus.start&&line<=current.focus.end&&(!best||best.id===current.inner);
    const scope=stay?FOCUS:(best?.id||MODULE);
    if(scope!==current.scope){navigate(file.path,scope,{line,source:true,scroll},'replace');return;}
    focusLine(line,scroll);
  }
  function focusLine(line,scroll){
    const raw=rawAt(line), orig=current.graph;ensureGraph(raw?.id);if(current.graph!==orig)drawGraph();
    if(raw&&current.graph.nodes.has(raw.id))activate(raw.id,{manual:true,line,scrollSource:scroll});
    else {if(current.active)saveTrail();current.active=null;current.line=line;sourceLine(line,line,line,scroll);drawState();syncRoute();}
  }
  function pathTo(start,goal,skipExceptions=true){
    if(!start)return null;
    const seen=new Set([start]), q=[{id:start,edges:[]}];
    for(let i=0;i<q.length;i++) {
      const cur=q[i];if(goal(cur.id))return cur.edges;
      for(const e of current.graph.links.get(cur.id)||[]) {
        if((skipExceptions&&e.kind==='exception')||e.back||e.requires||seen.has(e.to))continue;
        seen.add(e.to);q.push({id:e.to,edges:[...cur.edges,e]});
      }
    }
    return null;
  }
  function deriveRoute(){
    current.route=null;const {mode,graph}=current;if(mode==='all'||!graph.entry)return;
    let walk=null;
    if(mode==='return'||mode==='tool')walk=pathTo(graph.entry,id=>{const n=graph.nodes.get(id);return mode==='tool'?n.kind==='tool':n.s.kind==='Return'&&!n.s.synthetic;});
    else {
      const sorted=mode==='retry'?[...graph.edges.filter(e=>e.kind==='exception'&&!e.sets),...graph.edges.filter(e=>e.back)]:graph.edges.filter(e=>e.label===(mode==='yes'?'Yes':'No'));
      for(const e of sorted){
        if(e.requires)continue;
        const a=pathTo(graph.entry,id=>id===e.from,false);
        if(a){
          walk=[...a,e];
          if(mode==='retry'&&!e.back){
            for(const b of graph.edges.filter(x=>x.back&&!x.requires)){
              const tail=pathTo(e.to,id=>id===b.from,false);if(tail){walk.push(...tail,b);break;}
            }
          }else if(mode==='yes'||mode==='no'){
            const tail=pathTo(e.to,id=>{const n=graph.nodes.get(id);return n.kind==='exit'||!(graph.links.get(id)||[]).some(link=>!link.back&&link.kind!=='exception');});
            if(tail)walk.push(...tail);
          }
          break;
        }
      }
    }
    if(!walk)return;
    current.route={nodes:new Set([graph.entry,...walk.map(e=>e.to)]),ids:new Set(walk.map(edgeKey)),walk,index:0};
  }
  $('path-mode').onchange=e=>{current.mode=e.target.value;deriveRoute();reset();};
  function saveTrail(){current.trail.push({routeIndex:current.route?.index,id:current.active,line:current.line,flags:{...current.flags},loops:{...current.loops}});if(current.trail.length>600)current.trail.shift();}
  function options(){const all=current.graph?.links.get(current.active)||[];return all.filter(e=>!e.requires||current.flags[e.requires.split(':').slice(0,-1).join(':')]===e.requires);}
  function applyEdge(edge){
    if(!edge)return;
    current.edges.add(edgeKey(edge));
    if(edge.sets)current.flags[edge.sets.split(':').slice(0,-1).join(':')]=edge.sets;
    if(edge.back)current.loops[edge.to]=(current.loops[edge.to]||0)+1;
  }
  function activate(id,{manual=false,edge=null,line,scrollSource=true,centerNode=true,record=true}={}){
    const n=current.graph?.nodes.get(id);if(!n)return;
    if(manual){pause();$('play-state').textContent='';}
    if(current.active!==id||edge){if(record)saveTrail();applyEdge(edge||options().find(o=>o.to===id));}
    current.active=id;current.line=n.s.synthetic?(current.line||0):(line||n.s.start);current.visits.add(id);
    if(!n.s.synthetic)sourceLine(current.line,n.s.start,n.s.head||n.s.end,scrollSource);
    if(centerNode)center(n);drawState();syncRoute();
  }
  function chooseEdge(e){
    if(current.active!==e.from)activate(e.from,{manual:true});
    if(!options().includes(e)){$('play-state').textContent='需先经过对应入口';return;}
    activate(e.to,{manual:true,edge:e});
  }
  function next(){
    if(!current.active){if(current.graph.entry){activate(current.graph.entry);return true;}return false;}
    const candidates=options().filter(e=>e.kind!=='exception');
    const n=current.graph.nodes.get(current.active);
    const route=current.route;
    if(route&&route.index<route.walk.length) {
      const edge=route.walk[route.index];
      if(edge.from===current.active&&options().includes(edge)) {activate(edge.to,{edge});route.index++;return true;}
    }
    if(route&&route.index>=route.walk.length){$('play-state').textContent='已走完所选路径';return false;}
    let desired=candidates[0];
    if(n?.kind==='loop'&&current.loops[n.id])desired=candidates.find(e=>['No','已迭代完','break'].includes(e.label))||desired;
    if(desired?.back&&(current.loops[desired.to]||0)>=1){$('play-state').textContent='已查看一次回环';return false;}
    if(!desired){$('play-state').textContent=options().length?'选择异常分支':'此路径已结束';return false;}
    activate(desired.to,{edge:desired});return true;
  }
  function previous(){
    pause();const last=current.trail.pop();if(!last)return;
    current.flags=last.flags;current.loops=last.loops;if(current.route)current.route.index=last.routeIndex||0;current.active=last.id;current.line=last.line;
    const n=current.graph.nodes.get(last.id);
    if(n)activate(n.id,{line:last.line,record:false});
    else if(last.line)focusLine(last.line,true);else {sourceLine(null);drawState();syncRoute();}
    $('play-state').textContent='';
  }
  function pause(){viewport.classList.remove('running');if(timer){clearTimeout(timer);timer=null;}$('play').textContent='播放';$('play').setAttribute('aria-label','播放');}
  function play(){
    if(timer){pause();return;}if(!current?.graph.entry)return;
    $('play-state').textContent='';viewport.classList.add('running');$('play').textContent='暂停';$('play').setAttribute('aria-label','暂停');
    const tick=()=>{if(!next()){pause();drawState();return;}timer=setTimeout(tick,980/Number($('speed').value));};
    timer=setTimeout(tick,980/Number($('speed').value));
  }
  function reset(){
    pause();$('play-state').textContent='';current.active=null;current.line=null;current.trail=[];current.edges.clear();current.visits.clear();current.flags={};current.loops={};if(current.route)current.route.index=0;
    fit();if(current.graph.entry)activate(current.graph.entry,{record:false});
  }
  $('prev').onclick=previous;$('next').onclick=()=>{pause();$('play-state').textContent='';next();};$('reset').onclick=reset;$('play').onclick=play;

  function hashOf(path,scope,line,id){const p=new URLSearchParams({file:path,scope});if(line)p.set('line',line);if(id)p.set('node',id);return '#'+p;}
  function syncRoute(){
    if(!current)return;const h=hashOf(current.file.path,current.scope,current.line,current.active);lastHash=h;
    if(h!==location.hash)history.replaceState(history.state,'',h);
  }
  function defaultScope(file){
    if(file.focus)return file.focus.node?FOCUS:file.focus.scope;
    const main=file.symbols.find(s=>s.name==='main'&&s.kind!=='class');return main?.id||MODULE;
  }
  function validScope(file,scope){return scope===MODULE||(scope===FOCUS&&file.focus?.node)||file.symbols.some(s=>s.id===scope);}
  function jump(target){navigate(target.path,target.symbol,{line:target.line},'call');}
  function navigate(path,scope,opts={},kind='open'){
    if(!own(files,path))return;scope=scope??defaultScope(files[path]);
    const hash=hashOf(path,scope,opts.line,opts.node);
    if(kind==='call'&&current){if(hash===location.hash)return;history.pushState({call:true,backHash:location.hash},'',hash);}
    else if(kind==='replace')history.replaceState(history.state,'',hash);
    else if(hash!==location.hash)history.pushState(null,'',hash);
    show(path,scope,opts);syncRoute();
  }
  function snapshot(){if(current){current.camera={...camera};current.scroll={top:source.scrollTop,left:source.scrollLeft};}}
  function show(path,scope,opts={}){
    pause();$('play-state').textContent='';const old=current;const file=files[path];
    scope=validScope(file,scope)?scope:defaultScope(file);
    snapshot();current=getSession(file,scope);
    $('home-top').hidden=true;$('overview').hidden=true;$('work-top').hidden=false;$('explore').hidden=false;
    $('file-path').textContent=path;document.title=`${path} · CodeLens`;$('return').hidden=!history.state?.call;
    const changedFile=old?.file!==file;
    if(changedFile)renderSource(file);
    $('scopes').value=scope;ensureGraph(opts.node);drawGraph();
    if(current.camera){camera={...current.camera};paintCamera();}else fit();
    const start=current.focus?.start||file.symbols.find(s=>s.id===scope)?.start||1;
    if(opts.source){focusLine(opts.line,opts.scroll);return;}
    if(opts.node&&current.graph.nodes.has(opts.node)) {current.active=opts.node;activate(opts.node,{line:opts.line,record:false,centerNode:!current.camera,scrollSource:!current.scroll});}
    else if(opts.line&&opts.line!==start)focusLine(opts.line,true);
    else if(current.active&&current.graph.nodes.has(current.active))activate(current.active,{line:current.line,record:false,centerNode:!current.camera,scrollSource:!current.scroll});
    else if(current.graph.entry){activate(current.graph.entry,{record:false});if(opts.line===start&&scope!==FOCUS)sourceLine(start,start,start);}
    else {current.line=start;sourceLine(start);drawState();}
    if(current.scroll){source.scrollTop=current.scroll.top;source.scrollLeft=current.scroll.left;}
    if(opts.line===start&&scope!==FOCUS&&!opts.node){current.line=start;sourceLine(start,start,start);drawState();}
  }
  function goHome(push=false){
    pause();snapshot();current=null;lastHash='';if(push&&location.hash)history.pushState(null,'',location.href.split('#')[0]);
    $('home-top').hidden=false;$('overview').hidden=false;$('work-top').hidden=true;$('explore').hidden=true;document.title=`${D.name} · CodeLens`;
  }
  function restore(){
    if(lastHash===location.hash&&(current||!location.hash))return;
    lastHash=location.hash;const p=new URLSearchParams(location.hash.slice(1)), path=p.get('file'), file=path&&own(files,path)?files[path]:null;
    if(!file){goHome();return;}
    const num=Number(p.get('line'));show(path,p.get('scope')||defaultScope(file),{line:Number.isSafeInteger(num)&&num>0?num:undefined,node:p.get('node')});syncRoute();
  }
  $('scopes').onchange=e=>navigate(current.file.path,e.target.value,{},'replace');$('home').onclick=()=>goHome(true);
  $('return').onclick=()=>{if(history.state?.call){pause();history.back();}};
  window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore);
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(current)displaySearch(true);else $('search-files').focus();}});
  restore();
})();
