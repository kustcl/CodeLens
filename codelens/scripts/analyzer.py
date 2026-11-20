"""Shared project indexing and Python analysis for CodeLens."""
from __future__ import annotations

import ast
from collections import Counter, defaultdict
from hashlib import sha256
import io
import keyword
import json
from pathlib import Path
import re
import stat
import shutil
import subprocess
import token
import tokenize
import tomllib

DEFS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
MODULE = '(module)'
SOURCE_KINDS = {'.py': 'python', '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript'}

SKIP_DIRS = {'venv', 'node_modules', '__pycache__', 'build', 'dist', 'site-packages', 'checkpoints', 'wandb', 'env', 'htmlcov'}
PRIVATE = re.compile(r'(?i)^(?:\.|(?:id_(?:rsa|ed25519)|credentials?|secrets?)(?:[._-]|$))')
KEY_FILES = {'readme.md': '项目介绍与使用方式', 'readme.rst': '项目介绍与使用方式', 'pyproject.toml': '项目元数据、依赖与入口声明', 'setup.cfg': '打包或工具配置', 'setup.py': '打包配置脚本', 'requirements.txt': '依赖清单', 'license': '软件许可', 'license.md': '软件许可', 'makefile': '构建与开发命令', 'package.json': '项目脚本与依赖清单', 'tsconfig.json': 'TypeScript 编译配置'}


def module_identity(rel):
    parts = Path(rel).with_suffix('').parts
    if parts[0] == 'src' and len(parts) > 1:
        parts = parts[1:]
    is_init = parts[-1] == '__init__'
    module = '.'.join(parts[:-1] if is_init else parts)
    return module, module if is_init else module.rpartition('.')[0]


def excluded(name):
    return (bool(PRIVATE.match(name)) or Path(name).suffix.lower() in {'.key', '.pem', '.pfx', '.p12'})


def linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def code(node, limit=96):
    text = ast.unparse(node)
    text = ' '.join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + '…'


def start(node):
    return getattr(node, 'codelens_start', node.lineno)


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        return parent + '.' + node.attr if parent else None
    return None


def local_nodes(node):
    """Walk a lexical body without walking nested definition bodies."""
    yield node
    if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
        # Walrus targets inside comprehensions can bind in the enclosing scope.
        for child in ast.walk(node):
            if isinstance(child, ast.NamedExpr):
                yield child.target
        return
    if isinstance(node, DEFS):
        children = [*node.decorator_list]
        if isinstance(node, FUNCTIONS):
            children += [*node.args.defaults, *(d for d in node.args.kw_defaults if d is not None)]
            if node.returns:
                children.append(node.returns)
        else:
            children += [*node.bases, *node.keywords]
    else:
        children = ast.iter_child_nodes(node)
    for child in children:
        yield from local_nodes(child)


def bindings(body, args=None):
    counts = Counter()
    wildcard = False
    if args:
        counts.update(a.arg for a in ast.walk(args) if isinstance(a, ast.arg))
    for statement in body:
        for node in local_nodes(statement):
            if isinstance(node, DEFS):
                counts[node.name] += 1
            elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                counts[node.id] += 1
            elif isinstance(node, ast.Import):
                counts.update(a.asname or a.name.split('.')[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                wildcard |= any(a.name == '*' for a in node.names)
                counts.update(a.asname or a.name for a in node.names if a.name != '*')
            elif isinstance(node, (ast.Global, ast.Nonlocal)):
                counts.update(node.names)
            elif isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and node.name:
                counts[node.name] += 1
            elif isinstance(node, ast.MatchMapping) and node.rest:
                counts[node.rest] += 1
    return counts, wildcard


def split_source(text, language='python'):
    """Match the parser's physical line boundaries (not str.splitlines)."""
    if not text:
        return []
    if language == 'typescript':
        return re.split(r'[\n\u2028\u2029]', text[:-1] if text[-1] in '\n\u2028\u2029' else text)
    return text.removesuffix('\n').split('\n')


def tokens(text, lines):
    result = defaultdict(list)
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            kind = {token.STRING: 'str', token.NUMBER: 'num', token.COMMENT: 'com', token.OP: 'op'}.get(tok.type)
            if tok.type == token.NAME:
                kind = 'kw' if keyword.iskeyword(tok.string) else None
            elif token.tok_name.get(tok.type, '').startswith('FSTRING'):
                kind = 'str'
            if not kind:
                continue
            first, last = tok.start[0], min(tok.end[0], len(lines))
            for row in range(first, last + 1):
                line = lines[row - 1]
                left = tok.start[1] if row == first else 0
                right = tok.end[1] if row == tok.end[0] else len(line)
                if left < right:
                    # JS offsets are UTF-16, Python tokenize offsets count code points.
                    a, b = (len(line[:x].encode('utf-16-le')) // 2 for x in (left, right))
                    result[row].append([a, b, kind])
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return dict(result)


def import_base(node, package):
    if not node.level:
        return node.module or ''
    parts = package.split('.') if package else []
    if node.level > len(parts):
        return None
    prefix = parts[:len(parts) - node.level + 1]
    return '.'.join([*prefix, *([node.module] if node.module else [])])


def main_guard(node):
    return (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
            and len(node.test.ops) == 1 and isinstance(node.test.ops[0], ast.Eq)
            and {ast.unparse(node.test.left), ast.unparse(node.test.comparators[0])}
            in ({'__name__', "'__main__'"}, {'__name__', '"__main__"'}))


def statement_label(node):
    if isinstance(node, DEFS):
        return ('类 ' if isinstance(node, ast.ClassDef) else '定义 ') + node.name
    if isinstance(node, ast.If):
        return 'if ' + code(node.test)
    if isinstance(node, (ast.For, ast.AsyncFor)):
        return ('async for ' if isinstance(node, ast.AsyncFor) else 'for ') + code(node.target) + ' in ' + code(node.iter)
    if isinstance(node, ast.While):
        return 'while ' + code(node.test)
    if isinstance(node, (ast.Try, getattr(ast, 'TryStar', ast.Try))):
        return 'try · 异常处理'
    if isinstance(node, (ast.With, ast.AsyncWith)):
        return ('async with ' if isinstance(node, ast.AsyncWith) else 'with ') + ', '.join(code(x.context_expr) for x in node.items)
    if isinstance(node, ast.Match):
        return 'match ' + code(node.subject)
    return code(node)


def describe_step(node, calls):
    writes = []
    if isinstance(node, ast.Assign):
        writes = [code(target) for target in node.targets]
    elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        writes = [code(node.target)]
    reads = sorted({n.id for n in local_nodes(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}) if not lanes(node) else []
    hint = None
    names = [c['name'] for c in calls]
    for suffix, label in [('backward', '反向传播调用候选'), ('step', '参数更新或调度候选'), ('cross_entropy', '交叉熵损失调用候选'), ('scaled_dot_product_attention', '注意力计算候选'), ('flash_attn_func', '注意力计算候选'), ('view', '形状操作候选'), ('reshape', '形状操作候选'), ('transpose', '形状操作候选')]:
        if any(x.split('.')[-1] == suffix for x in names):
            hint = label + '（按名称提示，不推断运行时张量）'
            break
    if isinstance(node, ast.If):
        summary = '先判断条件，再进入相应分支。下方展示源码中的分支，不代表都会执行。'
    elif isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
        summary = '进入循环。循环体可能执行多次、一次或不执行；退出方式取决于实际输入和控制语句。'
    elif isinstance(node, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
        summary = {'Return': '结束当前函数并返回结果。', 'Raise': '抛出异常，后续取决于异常处理。', 'Break': '退出最近的循环。', 'Continue': '跳至最近的循环的下一次迭代。'}[type(node).__name__]
    elif isinstance(node, DEFS):
        summary = '建立定义。可在源码导航中切换到该定义的内部流程。'
    elif writes:
        summary = '更新 ' + '、'.join(writes) + '。'
    elif calls:
        summary = '包含 ' + '、'.join(dict.fromkeys(names)) + ' 等调用表达式。'
    else:
        summary = '此语句在当前作用域的位置由源码行号标出。'
    return summary, writes, reads[:12], hint


def lanes(node):
    if isinstance(node, ast.If):
        return [('条件成立', node.body), ('否则 / elif', node.orelse)]
    if isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
        return [('循环体 ↺', node.body), ('正常结束 / else', node.orelse)]
    if isinstance(node, (ast.Try, getattr(ast, 'TryStar', ast.Try))):
        return [('保护区', node.body), *[('except ' + (code(h.type) if h.type else ''), h.body) for h in node.handlers], ('无异常 / else', node.orelse), ('finally', node.finalbody)]
    if isinstance(node, (ast.With, ast.AsyncWith)):
        return [('上下文内', node.body)]
    if isinstance(node, ast.Match):
        return [('case ' + code(c.pattern) + (' if ' + code(c.guard) if c.guard else ''), c.body) for c in node.cases]
    return []


def controls(node):
    """Stable lane roles, independent of the text shown by the browser."""
    raw = lanes(node)
    if isinstance(node, ast.If):
        ids = ('yes', 'no')
    elif isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
        ids = ('body', 'else')
    elif isinstance(node, (ast.Try, getattr(ast, 'TryStar', ast.Try))):
        ids = ('body', *('except' for _ in node.handlers), 'else', 'finally')
    elif isinstance(node, (ast.With, ast.AsyncWith)):
        ids = ('body',)
    else:
        ids = ('case',) * len(raw)
    return [(role, label.strip(), body) for role, (label, body) in zip(ids, raw)]


def direct_nodes(node):
    """Calls in the controlling expression, not in child statements."""
    bodies = {id(child) for _, group in lanes(node) for child in group}
    if isinstance(node, DEFS):
        bodies.update(map(id, node.body))
    def visit(item, dynamic=False):
        if id(item) in bodies:
            return
        if isinstance(item, ast.Call):
            yield item, dynamic
        dynamic |= isinstance(item, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp))
        for child in ast.iter_child_nodes(item):
            yield from visit(child, dynamic)
    yield from visit(node)


class Project:
    def __init__(self, root, *, excludes=(), focuses=(), max_files=1000, max_file_bytes=1_000_000, budget_bytes=12_000_000, omit=(), only_flows=None, language='auto'):
        self.root = root.resolve()
        if not self.root.is_dir():
            raise ValueError(f'Not a directory: {root}')
        self.data = {'version': 1, 'name': self.root.name, 'tree': [], 'files': {}, 'warnings': [], 'reading': [], 'dependencies': []}
        self.context = {}
        self.modules = defaultdict(set)
        self.desc = {}
        self.reverse = defaultdict(list)
        self.omit = set(omit)
        self.language = language
        self.scan(set(excludes), focuses, max_files, max_file_bytes, budget_bytes)
        self.analyze(only_flows)

    def scan(self, excludes, focuses, max_files, max_file_bytes, budget_bytes):
        tree = self.data['tree']
        candidates = []
        def visit(directory, path=''):
            try:
                entries = sorted(directory.iterdir(), key=lambda item: item.name.casefold())
            except OSError:
                self.data['warnings'].append(f'{path or "."}: 无法列出目录')
                return
            for item in entries:
                rel = f'{path}/{item.name}' if path else item.name
                if rel in self.omit or rel in excludes or excluded(item.name):
                    continue
                try:
                    if linked(item):
                        continue
                    if item.is_dir():
                        if item.name in SKIP_DIRS:
                            continue
                        tree.append({'path': rel, 'kind': 'directory'})
                        visit(item, rel)
                    elif item.is_file():
                        kind = SOURCE_KINDS.get(item.suffix)
                        if kind and self.language in ('auto', kind):
                            entry = {'path': rel, 'kind': kind, **({'key': True} if item.name.lower() in KEY_FILES else {})}
                            if kind == 'python':
                                module, _ = module_identity(rel)
                                if module and all(part.isidentifier() for part in module.split('.')):
                                    self.modules[module].add(rel)
                            tree.append(entry)
                            candidates.append((rel, entry))
                        else:
                            tree.append({'path': rel, 'kind': 'file', **({'key': True, 'summary': KEY_FILES[item.name.lower()]} if item.name.lower() in KEY_FILES else {})})
                except OSError:
                    self.data['warnings'].append(f'{rel}: 无法读取路径')
        visit(self.root)
        paths = {rel for rel, _ in candidates}
        unknown = set(focuses) - paths
        if unknown:
            raise ValueError('Focus is not an included source file: ' + ', '.join(sorted(unknown)))
        weights = {p: i for i, p in enumerate(focuses)}
        candidates.sort(key=lambda it: (it[0] not in weights, weights.get(it[0], 0), self.role(it[0])[0], it[0]))
        for rel, entry in candidates:
            item = self.root / rel
            try:
                size = item.stat().st_size
                reason = ('单文件大小超限' if size > max_file_bytes else '导出范围超限' if len(self.data['files']) >= max_files or budget_bytes < size else '')
                if reason:
                    entry['status'] = reason
                    continue
                # Bound the read even if the file changes after stat().
                cap = min(max_file_bytes, budget_bytes)
                with item.open('rb') as stream:
                    raw = stream.read(cap + 1)
                if len(raw) > cap:
                    entry['status'] = '导出范围超限'
                    continue
                language = entry['kind']
                encoding = tokenize.detect_encoding(io.BytesIO(raw).readline)[0] if language == 'python' else 'utf-8-sig'
                source = raw.decode(encoding).replace('\r\n', '\n').replace('\r', '\n')
                budget_bytes -= len(raw)
                module, package = module_identity(rel) if language == 'python' else (rel, '')
                file = {'path': rel, 'language': language, 'module': module, 'source': source, 'sha256': sha256(raw).hexdigest(), 'symbols': [], 'flows': {}, 'entry': []}
                self.data['files'][rel] = file
                if language != 'python':
                    continue
                try:
                    parsed = ast.parse(source, filename=rel)
                except (ValueError, SyntaxError, RecursionError) as exc:
                    file['error'] = f'AST 未解析：{getattr(exc, "msg", str(exc))}'
                    file['summary'] = '可阅读原始源码；没有可用的 AST 流程。'
                    continue
                self.context[rel] = {'ast': parsed, 'package': package, 'definitions': {}, 'imports': {}, 'scopes': {}}
            except (OSError, UnicodeError, SyntaxError, LookupError) as exc:
                entry['status'] = '读取或编码失败'
                self.data['warnings'].append(f'{rel}: {type(exc).__name__}')
        skipped_focus = set(focuses) - self.data['files'].keys()
        if skipped_focus:
            raise ValueError('Focus exceeds bounds or could not be read: ' + ', '.join(sorted(skipped_focus)))

    @staticmethod
    def role(path):
        parts = path.lower().split('/')
        stem = Path(path).stem.lower()
        if stem in {'__main__', 'main', 'cli', 'app', 'base_train', 'train'}:
            return 0, '入口候选'
        if any(p in {'tests', 'test'} for p in parts) or stem.startswith('test_'):
            return 4, '测试'
        if parts[0] in {'scripts', 'examples', 'dev'}:
            return 2, '脚本 / 示例'
        if stem == '__init__':
            return 3, '包入口'
        return 1, '实现模块'

    def unique_module(self, module):
        matches = self.modules.get(module, ())
        return next(iter(matches)) if len(matches) == 1 else None

    def analyze(self, only_flows):
        files = self.data['files']
        for path, file in files.items():
            file['role'] = self.role(path)[1]
            if file['language'] != 'python':
                continue
            if only_flows is None:
                file['syntax'] = tokens(file['source'], split_source(file['source']))
            if path in self.context:
                self.catalog(path, file, self.context[path])
        self.entrypoints()
        for path, ctx in self.context.items():
            file = files[path]
            counts = Counter()
            for node in ast.walk(ctx['ast']):
                if isinstance(node, ast.Import):
                    deps = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    base = import_base(node, ctx['package'])
                    deps = [] if base is None else [base, *[f'{base}.{a.name}' if base else a.name for a in node.names]]
                else:
                    continue
                for dep in {self.unique_module(name) for name in deps} - {None, path}:
                    counts[dep] += 1
            self.data['dependencies'].extend({'from': path, 'to': dest, 'count': n} for dest, n in sorted(counts.items()))
            for scope, (node, _, _, _) in ctx['scopes'].items():
                if only_flows is None or (path, scope) in only_flows:
                    file['flows'][scope] = self.flow(path, scope, node.body)
        self.analyze_typescript(only_flows)
        self.data['incoming'] = [{'path': path, 'symbol': symbol, 'calls': values} for (path, symbol), values in sorted(self.reverse.items())]
        for path, file in files.items():
            if file['entry']:
                file['role'] = '入口'
        deps = Counter(d['to'] for d in self.data['dependencies'])
        reading = sorted(files, key=lambda p: (not files[p]['entry'], self.role(p)[0], -deps[p], p))[:10]
        self.data['reading'] = [{'path': p, 'reason': (' · '.join(files[p]['entry']) if files[p]['entry'] else (f'被 {deps[p]} 个已索引模块导入' if deps[p] else files[p]['role']))} for p in reading]

    def analyze_typescript(self, only_flows):
        files = {path: file for path, file in self.data['files'].items() if file['language'] == 'typescript'}
        if not files:
            return
        scripts = Path(__file__).resolve().parent
        setup = f'npm ci --ignore-scripts --prefix "{scripts}"'
        node = shutil.which('node')
        if not node or not (scripts / 'node_modules/typescript/package.json').is_file():
            raise ValueError(f'TypeScript export needs Node.js and the bundled parser dependency. Run: {setup}. For Python only, use --language python.')
        payload = {'files': {path: file['source'] for path, file in files.items()},
                   'request': None if only_flows is None else sorted(only_flows)}
        try:
            done = subprocess.run([node, str(scripts / 'typescript.cjs')], cwd=scripts,
                                  input=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                                  capture_output=True, timeout=90, check=True)
            result = json.loads(done.stdout)
        except subprocess.CalledProcessError as exc:
            error = exc.stderr.decode('utf-8', errors='replace').strip().splitlines()
            reason = next((line for line in error if 'Error:' in line), error[0] if error else str(exc))
            raise ValueError('TypeScript parser failed: ' + reason) from exc
        except subprocess.TimeoutExpired as exc:
            raise ValueError('TypeScript parser timed out; try smaller export bounds or exclude generated files') from exc
        for path, data in result['files'].items():
            files[path].update(data)
        self.data['dependencies'].extend(result['dependencies'])
        for item in result['incoming']:
            self.reverse[item['path'], item['symbol']].extend(item['calls'])

    def catalog(self, path, file, ctx):
        module = ctx['ast']
        absolute = set()
        ctx['scopes'][MODULE] = (module, None, *bindings(module.body))
        for node in module.body:
            if main_guard(node):
                file['entry'].append(f'__main__ guard · L{node.lineno}')
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname or alias.name.split('.')[0]
                    ctx['imports'][name] = (alias.name, None, node.lineno, not alias.asname)
            elif isinstance(node, ast.ImportFrom):
                base = import_base(node, ctx['package'])
                if base is not None:
                    for alias in node.names:
                        if alias.name != '*':
                            ctx['imports'][alias.asname or alias.name] = (base, alias.name, node.lineno, False)
            if isinstance(node, DEFS):
                absolute.add(id(node))
        if Path(path).name == '__main__.py':
            file['entry'].append('Python __main__.py')
        used = Counter()
        physical = split_source(file['source'])
        def definitions(body, parent):
            for node in body:
                if not isinstance(node, DEFS):
                    for _, group in lanes(node):
                        definitions(group, parent)
                    continue
                top = parent == MODULE
                parent_name = '' if top else ctx['scopes'][parent][0].codelens_name
                name = node.name if top else f'{parent_name}.{node.name}'
                node.codelens_name = name
                used[name] += 1
                sid = name if used[name] == 1 else f'{name}@{node.lineno}'
                ctx['scopes'][sid] = (node, parent, *bindings(node.body, getattr(node, 'args', None)))
                node.codelens_id = sid
                if node.decorator_list:
                    first = node.decorator_list[0].lineno
                    # AST starts at the decorator expression, which may begin below '@('.
                    column = node.col_offset
                    for row in range(first, 0, -1):
                        text = physical[row - 1]
                        if len(text) > column and text[column] == '@' and not text[:column].strip():
                            first = row
                            break
                    node.codelens_start = first
                info = {'id': sid, 'name': name, 'kind': 'class' if isinstance(node, ast.ClassDef) else 'async' if isinstance(node, ast.AsyncFunctionDef) else 'def', 'start': start(node), 'line': node.lineno, 'end': node.end_lineno, 'decorators': [code(d) for d in node.decorator_list]}
                doc = ast.get_docstring(node) or ''
                info['summary'] = doc.splitlines()[0][:200] if doc else ''
                if isinstance(node, ast.ClassDef):
                    info['bases'] = [code(base) for base in node.bases]
                    aliases = ctx['imports']
                    def expand(base):
                        head, _, tail = base.partition('.')
                        binding = aliases.get(head)
                        if not binding or ctx['scopes'][MODULE][2][head] != 1 or binding[2] >= node.lineno:
                            return base
                        origin, member, _, bare = binding
                        return '.'.join(filter(None, [head if bare else origin, member, tail]))
                    if any(expand(base).startswith('torch.nn.') for base in info['bases']):
                        info['torch'] = 'torch.nn 基类线索，未执行模型'
                        children = []
                        for method in node.body:
                            if isinstance(method, FUNCTIONS) and method.name == '__init__':
                                for stmt in method.body:
                                    for inner in local_nodes(stmt):
                                        if isinstance(inner, (ast.Assign, ast.AnnAssign)) and isinstance(inner.value, ast.Call):
                                            targets = inner.targets if isinstance(inner, ast.Assign) else [inner.target]
                                            for target in targets:
                                                if (dotted(target) or '').startswith('self.'):
                                                    children.append({'name': code(target), 'type': code(inner.value.func), 'line': inner.lineno})
                        info['children'] = children
                file['symbols'].append(info)
                self.desc[path, sid] = info
                if id(node) in absolute:
                    ctx['definitions'][node.name] = sid
                definitions(node.body, sid)
        definitions(module.body, MODULE)
        doc = ast.get_docstring(module) or ''
        tops = [self.desc[path, x]['name'] for x in ctx['definitions'].values()]
        file['summary'] = doc.splitlines()[0][:220] if doc else (f'{file["role"]} · ' + '、'.join(tops[:5]) if tops else f'{file["role"]} · 模块级语句')

    def entrypoints(self):
        cfg = self.root / 'pyproject.toml'
        if 'pyproject.toml' in self.omit or not any(e['path'] == 'pyproject.toml' and e['kind'] == 'file' for e in self.data['tree']):
            return
        try:
            if linked(cfg) or not cfg.is_file() or cfg.stat().st_size > 1_000_000:
                return
            with cfg.open('rb') as stream:
                meta = tomllib.loads(stream.read(1_000_001).decode('utf-8'))
            desc = meta.get('project', {}).get('description')
            if isinstance(desc, str):
                self.data['description'] = ' '.join(desc.split())[:140]
            for group in ('scripts', 'gui-scripts'):
                for name, target in meta.get('project', {}).get(group, {}).items():
                    if isinstance(target, str):
                        mod, _, sym = target.partition(':')
                        path = self.unique_module(mod)
                        if path in self.data['files']:
                            self.data['files'][path]['entry'].append(f'{name} → {sym or mod} (pyproject.toml)')
        except (ValueError, OSError, AttributeError):
            self.data['warnings'].append('pyproject.toml 的入口声明无法读取')

    def module_symbol(self, path, name):
        ctx = self.context.get(path)
        if ctx and not ctx['scopes'][MODULE][3] and ctx['scopes'][MODULE][2][name] == 1:
            return ctx['definitions'].get(name)
        return None

    def lookup(self, path, scope, expr, line):
        if not expr:
            return None
        ctx = self.context[path]
        head, *tail = expr.split('.')
        sid = scope
        current, parent, counts, wild = ctx['scopes'][scope]
        if head == 'self' and len(tail) == 1 and isinstance(current, FUNCTIONS) and parent:
            owner, _, owner_counts, owner_wild = ctx['scopes'][parent]
            positional = current.args.posonlyargs + current.args.args
            if (isinstance(owner, ast.ClassDef) and positional and positional[0].arg == 'self'
                    and counts['self'] == 1 and not current.decorator_list and not owner_wild and owner_counts[tail[0]] == 1):
                for method in owner.body:
                    if isinstance(method, FUNCTIONS) and method.name == tail[0]:
                        return path, method.codelens_id, 'candidate'
        while sid != MODULE:
            scope_node, parent, counts, wild = ctx['scopes'][sid]
            if sid == scope and not tail and not wild and counts[head] == 1:
                for node in scope_node.body:
                    if isinstance(node, DEFS) and node.name == head and node.end_lineno < line:
                        return path, node.codelens_id, 'static'
            if head in counts or wild:
                return None
            sid = parent
            # Functions do not inherit the enclosing class namespace.
            while sid != MODULE and isinstance(ctx['scopes'][sid][0], ast.ClassDef):
                sid = ctx['scopes'][sid][1]
        _, _, counts, wild = ctx['scopes'][MODULE]
        if wild or counts[head] != 1:
            return None
        if not tail and (local := self.module_symbol(path, head)):
            if scope == MODULE and self.desc[path, local]['line'] >= line:
                return None
            return path, local, 'static'
        imported = ctx['imports'].get(head)
        if not imported:
            return None
        base, member, binding_line, bare = imported
        if scope == MODULE and binding_line >= line:
            return None
        if member:
            target_path = self.unique_module(base)
            if not tail and (found := self.module_symbol(target_path, member)):
                return target_path, found, 'static'
            if len(tail) == 1:
                # A package attribute can shadow an implicit submodule.
                target_ctx = self.context.get(target_path)
                if (target_path and not target_ctx) or (target_ctx and (target_ctx['scopes'][MODULE][3] or member in target_ctx['scopes'][MODULE][2])):
                    return None
                mod = f'{base}.{member}' if base else member
                target_path = self.unique_module(mod)
                if found := self.module_symbol(target_path, tail[0]):
                    return target_path, found, 'static'
        elif tail and (not bare or '.'.join([head, *tail[:-1]]) == base):
            target_path = self.unique_module(base)
            if (bare or len(tail) == 1) and (found := self.module_symbol(target_path, tail[-1])):
                return target_path, found, 'static'
        return None

    def flow(self, path, scope, body):
        physical = split_source(self.data['files'][path]['source'])
        def lane(role, title, group, node):
            item = {'role': role, 'label': title, 'steps': make(group)}
            if role == 'finally' and group:
                for row in range(start(group[0])-1, node.lineno, -1):
                    text = physical[row-1]
                    offset = len(text) - len(text.lstrip(' \t'))
                    if offset == node.col_offset and re.match(r'finally\s*:', text.lstrip()):
                        item['line'] = row
                        break
                else:
                    if 'finally' in physical[start(group[0])-1]:
                        item['line'] = start(group[0])
            return item
        def make(statements):
            steps = []
            for node in statements:
                children = lanes(node)
                callsites = []
                for call, dynamic in direct_nodes(node):
                    name = dotted(call.func)
                    site = {'name': name or code(call.func), 'line': call.lineno, 'end': call.end_lineno, 'status': 'unknown'}
                    target = None if dynamic else self.lookup(path, scope, name, call.lineno)
                    if target:
                        dest, symbol, certainty = target
                        info = self.desc[dest, symbol]
                        site.update(status=certainty, target={'path': dest, 'symbol': symbol, 'line': info['start']})
                        self.reverse[dest, symbol].append({'path': path, 'symbol': scope, 'line': call.lineno, 'status': certainty})
                    callsites.append(site)
                label = statement_label(node)
                if len(label) > 154:
                    label = label[:153] + '…'
                summary, writes, reads, hint = describe_step(node, callsites)
                step = {'id': f'{node.lineno}:{node.col_offset}', 'start': start(node), 'end': node.end_lineno, 'kind': type(node).__name__, 'label': label, 'summary': summary, 'calls': callsites}
                if isinstance(node, DEFS):
                    step['symbol'] = node.codelens_id
                if children:
                    step['lanes'] = [lane(role, title, group, node) for role, title, group in controls(node) if group or role in {'yes', 'no'}]
                if isinstance(node, ast.While) and isinstance(node.test, ast.Constant) and node.test.value is True:
                    step['always'] = True
                if isinstance(node, (ast.For, ast.AsyncFor)) and 'attempt' in code(node.target).lower():
                    step['retry'] = True
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    step['label'] = '导入 ' + (node.module or '.') if isinstance(node, ast.ImportFrom) else '导入 ' + ', '.join(a.name for a in node.names)
                if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    step['literal'] = True
                if isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.With, ast.AsyncWith, ast.Match)):
                    head = getattr(node, 'test', None) or getattr(node, 'iter', None) or getattr(node, 'subject', None)
                    if head is None and isinstance(node, (ast.With, ast.AsyncWith)):
                        head = node.items[-1].optional_vars or node.items[-1].context_expr
                    step['head'] = head.end_lineno if head else node.lineno
                elif children:
                    step['head'] = node.lineno
                if writes:
                    step['writes'] = writes
                if reads:
                    step['reads'] = reads
                if hint:
                    step['hint'] = hint
                steps.append(step)
            return steps
        return make(body)


def flatten(steps):
    for step in steps:
        yield step
        for lane in step.get('lanes', []):
            yield from flatten(lane['steps'])
