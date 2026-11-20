'use strict';
// Backend only. No project imports, config, plugins, builds, or execution.
const ts = require('./node_modules/typescript');
const {posix} = require('node:path');
const MODULE = '(module)';
const K = ts.SyntaxKind;
const inside = n => n && (ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n)) ? [...n.statements] : n ? [n] : [];
const visit = (n, fn) => ts.forEachChild(n, child => { fn(child); });
const has = (n, kind) => !!n.modifiers?.some(m => m.kind === kind);
const fn = n => (ts.isFunctionLike(n) && !!n.body);
const short = (s, max=140) => s.length>max ? s.slice(0,max-1)+'…' : s;
const compact = s => s.replace(/\s+/g,' ').trim();
const line = (sf, offset) => sf.getLineAndCharacterOfPosition(offset).line+1;
const first = (n,sf) => line(sf,n.getStart(sf));
const last = (n,sf) => line(sf,Math.max(n.getStart(sf),n.end-1));
const doc = n => n?.jsDoc?.map(d=>typeof d.comment==='string'?compact(d.comment):'').find(Boolean)||'';
const location = (n,sf) => {
  const p=sf.getLineAndCharacterOfPosition(n.getStart(sf)); return `${p.line+1}:${p.character}`;
};

// All coordinates are UTF-16, including non-BMP characters on the same line.
function highlight(sf) {
  const result=Object.create(null), starts=sf.getLineStarts();
  const type={comment:'com',keyword:'kw',number:'num',bigint:'num',string:'str',operator:'op',punctuation:'op',
    'jsx open tag name':'kw','jsx close tag name':'kw','jsx self closing tag name':'kw','jsx attribute string literal value':'str'};
  // Syntactic classifier from the pinned compiler. Unlike a standalone lexer,
  // its TSX, regex, comment and template spans follow the parser's context.
  const spans=ts.getSyntacticClassifications({throwIfCancellationRequested(){}},sf,{start:0,length:sf.text.length});
  for(const {textSpan,classificationType} of spans) {
    const kind=type[classificationType]; if(!kind)continue;
    const a=textSpan.start,b=a+textSpan.length;
    for(let r=line(sf,a)-1;r<starts.length&&starts[r]<b;r++){
      const base=starts[r], end=Math.min(b,r+1<starts.length?starts[r+1]-1:sf.text.length);
      if(end>Math.max(a,base))(result[r+1]||=[]).push([Math.max(a,base)-base,end-base,kind]);
    }
  }
  for(const row of Object.values(result))row.sort((a,b)=>a[0]-b[0]);
  return result;
}

function read({files,request}) {
  const vfs=new Map(Object.entries(files).map(([p,source])=>['/'+p,ts.createSourceFile('/'+p,source,ts.ScriptTarget.Latest,true)]));
  const ext={'.ts':ts.Extension.Ts,'.tsx':ts.Extension.Tsx,'.mts':ts.Extension.Mts,'.cts':ts.Extension.Cts};
  function resolve(name, origin) {
    if(!/^\.\.?\//.test(name)||name.includes('\\'))return;
    const base=posix.join(posix.dirname(origin.slice(1)),name);
    if(base==='..'||base.startsWith('../'))return;
    const relative='/'+base;
    const e=posix.extname(relative), map={'.js':['.ts','.tsx','.d.ts'],'.jsx':['.tsx','.ts','.d.ts'],'.mjs':['.mts','.d.mts'],'.cjs':['.cts','.d.cts']};
    const suffix=['.ts','.tsx','.mts','.cts','.d.ts','.d.mts','.d.cts'];
    const paths=ext[e]?[relative]:map[e]?map[e].map(s=>relative.slice(0,-e.length)+s)
      :[...suffix.map(s=>relative+s),...suffix.map(s=>posix.join(relative,'index'+s))];
    const target=paths.find(p=>vfs.has(p));
    return target?{resolvedFileName:target,extension:ext[posix.extname(target)],isExternalLibraryImport:false}:undefined;
  }
  const opts={target:ts.ScriptTarget.Latest,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.Preserve,noLib:true,types:[]};
  const host={getSourceFile:p=>vfs.get(p),getDefaultLibFileName:()=>'/lib.d.ts',getCurrentDirectory:()=>'/','useCaseSensitiveFileNames':()=>true,
    getCanonicalFileName:p=>p,getNewLine:()=>'\n',fileExists:p=>vfs.has(p),readFile:p=>vfs.get(p)?.text,writeFile:()=>{},
    resolveModuleNames:(names,origin)=>names.map(n=>resolve(n,origin))};
  const checker=ts.createProgram([...vfs.keys()],opts,host).getTypeChecker();
  const all=request===null, requested=new Set((request||[]).map(pair=>JSON.stringify(pair)));
  const output=Object.create(null), dependencies=[], incoming=new Map(), definitions=new Map(), mutations=new Set();
  const contexts=new Map();
  function catalog(sf,file) {
    const scopes=new Map([[MODULE,sf]]), used=new Set(), path=sf.fileName.slice(1);
    const nameOf=n=>n?.name&&(ts.isIdentifier(n.name)||ts.isPrivateIdentifier(n.name)||ts.isStringLiteral(n.name)||ts.isNumericLiteral(n.name))?n.name.text:null;
    function walk(node,parent='') {
      let entry=null, holder=node, name=null, kind;
      if((ts.isClassDeclaration(node)||ts.isClassExpression(node))&&!has(node,K.DeclareKeyword)) {
        name=nameOf(node)||(has(node,K.DefaultKeyword)?'default':null);kind='class';entry=node;
      } else if(ts.isVariableDeclaration(node)||ts.isPropertyDeclaration(node)) {
        const val=node.initializer;
        if(val&&(ts.isArrowFunction(val)||ts.isFunctionExpression(val)||ts.isClassExpression(val))) {
          name=nameOf(node);entry=val;kind=ts.isClassExpression(val)?'class':has(val,K.AsyncKeyword)?'async':'def';
        }
      } else if(ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node)||ts.isConstructorDeclaration(node)||ts.isGetAccessorDeclaration(node)||ts.isSetAccessorDeclaration(node)) {
        if(node.body) {
          entry=node;name=ts.isConstructorDeclaration(node)?'constructor':nameOf(node)||(has(node,K.DefaultKeyword)?'default':null);
          kind=has(node,K.AsyncKeyword)?'async':'def';
        }
      }
      if(entry&&name) {
        const qualified=parent?`${parent}.${name}`:name;
        let id=qualified;
        if(used.has(id))id+=`@${location(holder,sf)}`;
        used.add(id);
        const info={id,name:qualified,kind,start:first(holder,sf),line:first(holder.name||holder,sf),end:last(holder,sf),
          decorators:(ts.canHaveDecorators(holder)?ts.getDecorators(holder)||[]:[]).map(d=>short(compact(d.getText(sf)))),summary:short(doc(holder)||doc(holder.parent?.parent)||'',200)};
        file.symbols.push(info);
        definitions.set(holder,{path,info,entry});scopes.set(id,entry);parent=qualified;
        if(entry!==holder){visit(entry,c=>walk(c,parent));return;}
      }
      if(fn(node)&&!entry)return; // Anonymous callbacks are not inlined into their containing scope.
      visit(node,c=>walk(c,parent));
    }
    walk(sf);
    return scopes;
  }
  for(const [name,sf] of vfs){
    const path=name.slice(1), file=output[path]={symbols:[],flows:Object.create(null)};
    if(all)file.syntax=highlight(sf);
    if(sf.parseDiagnostics.length) {
      const d=sf.parseDiagnostics[0];
      file.error=`TypeScript 语法未解析（L${line(sf,d.start||0)}）：${ts.flattenDiagnosticMessageText(d.messageText,' ')}`;
      file.summary='可阅读原始源码；语法错误，未生成流程。';continue;
    }
    const scopes=catalog(sf,file);contexts.set(path,{file,sf,scopes});
    const names=file.symbols.filter(s=>!s.name.includes('.')).slice(0,4).map(s=>s.name);
    const intro=sf.text.match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[1]?.split('\n').map(s=>s.replace(/^\s*\*?\s*/,'')).find(s=>s&&!s.startsWith('@'));
    file.summary=short(intro||(names.length?`定义 ${names.join('、')}`:sf.isDeclarationFile?'TypeScript 类型声明':'TypeScript 模块级语句'),180);
    const imports=new Map();
    for(const n of sf.statements) {
      const spec=n.moduleSpecifier;
      if(!spec||!ts.isStringLiteral(spec))continue;
      const target=resolve(spec.text,name)?.resolvedFileName.slice(1);
      if(target&&target!==path)imports.set(target,(imports.get(target)||0)+1);
    }
    for(const [to,count] of imports)dependencies.push({from:path,to,count});
  }
  function underlying(sym) {
    if(!sym||checker.getTypeOnlyAliasDeclaration(sym))return null;
    return sym.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(sym):sym;
  }
  function symbolAt(expr) {
    if(!expr)return;
    if(ts.isIdentifier(expr))return underlying(checker.getSymbolAtLocation(expr));
    if(ts.isPropertyAccessExpression(expr)&&ts.isIdentifier(expr.expression)){
      const sym=checker.getSymbolAtLocation(expr.expression);
      if(sym?.declarations?.some(ts.isNamespaceImport)&&underlying(sym))return underlying(checker.getSymbolAtLocation(expr.name));
    }
  }
  function mutate(n) {
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=K.FirstAssignment&&n.operatorToken.kind<=K.LastAssignment){
      const mark=e=>{
        if(ts.isIdentifier(e)||ts.isPropertyAccessExpression(e)){
          const sym=symbolAt(e);if(sym)mutations.add(sym);
        } else visit(e,mark);
      };
      mark(n.left);
    } else if((ts.isPrefixUnaryExpression(n)||ts.isPostfixUnaryExpression(n))&&[K.PlusPlusToken,K.MinusMinusToken].includes(n.operator)){
      const sym=symbolAt(n.operand);if(sym)mutations.add(sym);
    }
    visit(n,mutate);
  }
  if(all||requested.size)for(const {sf} of contexts.values())mutate(sf);

  function targetOf(call,sf) {
    const callee=call.expression;
    if(!callee||call.questionDotToken||callee.questionDotToken)return;
    const sym=symbolAt(callee);if(!sym||mutations.has(sym))return;
    const indexed=(sym.declarations||[]).flatMap(d=>definitions.has(d)?[definitions.get(d)]:[]);
    if(indexed.length!==1)return;
    let [dest]=indexed;
    if(ts.isNewExpression(call)) {
      if(dest.info.kind!=='class')return;
      const ctors=dest.entry.members.filter(n=>ts.isConstructorDeclaration(n)&&n.body);
      dest=ctors.length===1?definitions.get(ctors[0]):null;
    }
    if(!dest||dest.info.kind==='class')return;
    if(dest.path!==sf.fileName.slice(1)&&!ts.isExternalModule(vfs.get('/'+dest.path)))return;
    // Do not treat mutable variables, unloaded overloads or inferred instance
    // methods as proven implementations. Resolve only named declaration/const.
    const decl=sym.declarations.find(d=>definitions.get(d)===indexed[0]);
    if(decl&&ts.isVariableDeclaration(decl)){
      if(!(decl.parent.flags&ts.NodeFlags.Const))return;
      if(decl.getSourceFile()===sf&&decl.getStart(sf)>call.getStart(sf))return;
    }
    return {path:dest.path,symbol:dest.info.id,line:dest.info.start};
  }

  function flow(scope,root,sf,path) {
    const text=n=>short(compact(n.getText(sf)));
    const syms=n=>definitions.get(n)?.info;
    function calls(n) {
      const sites=[];
      function walk(item){
        if(fn(item)||ts.isClassLike(item)||ts.isTypeNode(item))return;
        if(ts.isCallExpression(item)||ts.isNewExpression(item)||ts.isTaggedTemplateExpression(item)){
          const target=targetOf(item,sf), at=first(item,sf), status=target?'static':'unknown';
          sites.push({name:text(item.expression||item.tag),line:at,end:last(item,sf),status,...(target?{target}:{})});
          if(target){
            const key=JSON.stringify([target.path,target.symbol]);
            if(!incoming.has(key))incoming.set(key,{path:target.path,symbol:target.symbol,calls:[]});
            incoming.get(key).calls.push({path,symbol:scope,line:at,status});
          }
        }
        visit(item,walk);
      }
      if(n)walk(n);return sites;
    }
    const flat=body=>body.flatMap(n=>step(n));
    const lane=(role,label,n)=>({role,label,steps:flat(inside(n))});
    function step(n){
      if(!n||n.kind===K.EmptyStatement||ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n)||has(n,K.DeclareKeyword))return [];
      if(ts.isBlock(n))return flat(inside(n));
      if(ts.isFunctionDeclaration(n)&&!n.body)return [];
      if((ts.isImportDeclaration(n)&&n.importClause?.isTypeOnly)||(ts.isExportDeclaration(n)&&n.isTypeOnly))return [];
      if(ts.isImportDeclaration(n)&&!n.importClause?.name&&n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings)&&
          n.importClause.namedBindings.elements.length&&n.importClause.namedBindings.elements.every(e=>e.isTypeOnly))return [];
      const s={id:location(n,sf),start:first(n,sf),end:last(n,sf),kind:'Action',label:text(n),summary:'按静态源码顺序探索；不代表真实运行轨迹。',calls:[]};
      const expressions=[];
      const head=h=>s.head=h?last(h,sf):s.start;
      const def=syms(n), variable=ts.isVariableStatement(n), decls=variable?n.declarationList.declarations:[];
      if(def||variable&&decls.length===1&&syms(decls[0])){
        const d=def||syms(decls[0]);s.kind='Definition';s.symbol=d.id;s.label=`定义 ${d.name}`;s.summary='进入定义可查看内部流程。';
      } else if(ts.isIfStatement(n)){
        s.kind='If';s.label=`if ${text(n.expression)}`;s.summary='根据条件选择 Yes 或 No；没有求值。';
        head(n.expression);s.lanes=[lane('yes','Yes',n.thenStatement),lane('no','No',n.elseStatement)];expressions.push(n.expression);
      } else if(ts.isForStatement(n)||ts.isForInStatement(n)||ts.isForOfStatement(n)||ts.isWhileStatement(n)){
        const condition=ts.isForStatement(n)||ts.isWhileStatement(n);
        s.kind=condition?'While':'For';
        const expr=ts.isForStatement(n)?n.condition:n.expression;
        const end=n.getChildren(sf).find(c=>c.kind===K.CloseParenToken)?.end??n.statement.getStart(sf);
        s.label=short(compact(sf.text.slice(n.getStart(sf),end)));s.head=line(sf,Math.max(n.getStart(sf),end-1));
        s.lanes=[lane('body','循环体',n.statement)];
        if(condition&&(!expr||expr.kind===K.TrueKeyword))s.always=true;
        s.summary=ts.isForStatement(n)?'循环头概括初始化、条件和更新，未单独拆成节点。':'循环条件或迭代项决定继续、回环或退出。';
        if(ts.isForStatement(n))expressions.push(n.initializer,n.condition,n.incrementor);
        else expressions.push(expr);
      } else if(ts.isTryStatement(n)){
        s.kind='Try';s.label='try';head();s.summary='正常与异常分支是静态候选，不表示某条语句必定抛出。';
        s.lanes=[lane('body','try',n.tryBlock)];
        if(n.catchClause)s.lanes.push({...lane('except',`catch${n.catchClause.variableDeclaration?` (${text(n.catchClause.variableDeclaration)})`:''}`,n.catchClause.block),line:first(n.catchClause,sf)});
        if(n.finallyBlock){const token=n.getChildren(sf).find(c=>c.kind===K.FinallyKeyword);s.lanes.push({...lane('finally','finally',n.finallyBlock),line:first(token||n.finallyBlock,sf)});}
      } else if(ts.isReturnStatement(n)||ts.isThrowStatement(n)||ts.isBreakStatement(n)||ts.isContinueStatement(n)){
        s.kind=ts.isReturnStatement(n)?'Return':ts.isThrowStatement(n)?'Raise':ts.isBreakStatement(n)?'Break':'Continue';
        s.summary={Return:'返回并结束当前函数路径。',Raise:'抛出异常，结束当前正常路径。',Break:'跳出当前循环。',Continue:'回到循环头。'}[s.kind];expressions.push(n.expression);
      } else if(ts.isSwitchStatement(n)||ts.isDoStatement(n)||ts.isLabeledStatement(n)||ts.isWithStatement(n)||ts.isModuleDeclaration(n)){
        s.label=`${text(n).split('{')[0].trim()} …`;
        s.summary='当前不展开此语法的内部控制流；后续边仅表示源码顺序。';
      } else if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)){
        s.kind=ts.isImportDeclaration(n)?'Import':'Export';s.summary='建立模块依赖或导出绑定，不展开模块初始化。';
      } else {
        expressions.push(n);
        if(variable)s.writes=decls.map(d=>text(d.name));
      }
      s.calls=expressions.flatMap(calls);
      return [s];
    }
    if(sf.isDeclarationFile)return [];
    if(ts.isSourceFile(root))return flat(inside(root));
    if(ts.isClassLike(root))return flat(root.members.filter(n=>ts.isMethodDeclaration(n)||ts.isConstructorDeclaration(n)||ts.isGetAccessorDeclaration(n)||ts.isSetAccessorDeclaration(n)));
    if(!root.body)return [];
    if(ts.isBlock(root.body))return flat(inside(root.body));
    const e=root.body;
    return [{id:location(e,sf),start:first(e,sf),end:last(e,sf),kind:'Return',label:`返回 ${text(e)}`,summary:'箭头函数隐式返回此表达式。',calls:calls(e)}];
  }
  for(const [path,{sf,file,scopes}] of contexts){
    for(const [scope,root] of scopes)if(all||requested.has(JSON.stringify([path,scope])))file.flows[scope]=flow(scope,root,sf,path);
  }
  return {files:output,dependencies,incoming:[...incoming.values()]};
}

const input=require('node:fs').readFileSync(0,'utf8');
process.stdout.write(JSON.stringify(read(JSON.parse(input))));