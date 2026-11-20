"""CodeLens CLI: build an offline site or retrieve bounded source context."""
from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tempfile

sys.dont_write_bytecode = True
from analyzer import MODULE, SOURCE_KINDS, Project, flatten, split_source

ASSETS = Path(__file__).resolve().parent.parent / 'assets'


def dump(data):
    return json.dumps(data, ensure_ascii=False, separators=(',', ':'))


def load_notes(project, filenames):
    seen = set()
    has_reading = False
    catalogued = set()
    has_project = False
    for filename in filenames:
        with filename.open('rb') as stream:
            raw = stream.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError(f'Notes file exceeds 2 MB: {filename}')
        payload = json.loads(raw.decode('utf-8-sig'))
        if not isinstance(payload, dict) or payload.get('version') != 1 or not isinstance(payload.get('files'), dict):
            raise ValueError(f'{filename}: expected notes format version 1')
        if 'project' in payload:
            description = payload['project']
            if has_project or not isinstance(description, str) or not 1 <= len(description.strip()) <= 140:
                raise ValueError(f'{filename}: expected one project description of up to 140 characters')
            project.data['description'] = description.strip()
            has_project = True
        if 'catalog' in payload:
            catalog = payload['catalog']
            tree = {e['path']: e for e in project.data['tree']}
            if not isinstance(catalog, dict):
                raise ValueError(f'{filename}: catalog must be an object')
            for path, description in catalog.items():
                if path not in tree or path in catalogued or not isinstance(description, str) or not 1 <= len(description.strip()) <= 120:
                    raise ValueError(f'{filename}: invalid or duplicate catalog path: {path}')
                tree[path]['summary'] = description.strip()
                catalogued.add(path)
        if 'reading' in payload:
            entries = payload['reading']
            if has_reading or not isinstance(entries, list) or not 1 <= len(entries) <= 20:
                raise ValueError(f'{filename}: expected a single reading list with 1–20 items')
            paths = set()
            for row in entries:
                if (not isinstance(row, dict) or not isinstance(row.get('path'), str) or row['path'] not in project.data['files']
                        or row['path'] in paths or not isinstance(row.get('reason'), str) or not 1 <= len(row['reason'].strip()) <= 300):
                    raise ValueError(f'{filename}: invalid or duplicate reading item: {row}')
                paths.add(row['path'])
            project.data['reading'] = [{'path': row['path'], 'reason': row['reason'].strip()} for row in entries]
            has_reading = True
        for path, item in payload['files'].items():
            file = project.data['files'].get(path)
            if not isinstance(item, dict):
                raise ValueError(f'{filename}: invalid notes for {path}')
            if not file or item.get('sha256') != file['sha256']:
                raise ValueError(f'{filename}: source absent or changed for {path}; refresh notes with inspect')
            if path in seen:
                raise ValueError(f'{filename}: duplicate file across notes: {path}')
            seen.add(path)
            def field(obj, key, length):
                text = obj.get(key, '')
                if not isinstance(text, str) or len(text) > length:
                    raise ValueError(f'{filename}: invalid {key} for {path} (max {length} characters)')
                return text.strip()
            if summary := field(item, 'summary', 500):
                file['summary'] = summary
                file['annotated'] = True
            focus = item.get('focus')
            if focus is not None:
                if not isinstance(focus, dict) or not isinstance(focus.get('scope'), str) or focus['scope'] not in file['flows']:
                    raise ValueError(f'{filename}: invalid focus scope in {path}')
                node = focus.get('node')
                if node is not None and (not isinstance(node, str) or not any(s['id'] == node and s.get('lanes') for s in flatten(file['flows'][focus['scope']]))):
                    raise ValueError(f'{filename}: invalid focus node in {path}')
                file['focus'] = {'scope': focus['scope'], 'node': node, 'label': field(focus, 'label', 50)}
            if item.get('key') is True:
                file['key'] = True
            file['notes'] = {}
            scopes = item.get('scopes', {})
            if not isinstance(scopes, dict):
                raise ValueError(f'{filename}: scopes must be an object for {path}')
            for scope, notes in scopes.items():
                if scope not in file['flows'] or not isinstance(notes, dict):
                    raise ValueError(f'{filename}: unknown scope {path}::{scope}')
                matches = {step['id'] for step in flatten(file['flows'][scope])}
                steps = notes.get('steps', {})
                if not isinstance(steps, dict):
                    raise ValueError(f'{filename}: steps must be an object for {path}::{scope}')
                clean = {'summary': field(notes, 'summary', 800), 'steps': {}, 'groups': []}
                def blocks(level):
                    yield level
                    for entry in level:
                        for lane in entry.get('lanes', []):
                            yield from blocks(lane['steps'])
                positions = {step['id']: (level, index) for level in blocks(file['flows'][scope]) for index, step in enumerate(level)}
                groups = notes.get('groups', [])
                if not isinstance(groups, list):
                    raise ValueError(f'{filename}: groups must be a list for {path}::{scope}')
                occupied = set()
                for group in groups:
                    if not isinstance(group, dict) or not all(isinstance(group.get(k), str) and group[k] in positions for k in ('first', 'last')):
                        raise ValueError(f'{filename}: invalid group range for {path}::{scope}')
                    level, a = positions[group['first']]
                    other, b = positions[group['last']]
                    chunk = level[a:b+1]
                    if level is not other or a >= b or any(x.get('lanes') or x['id'] in occupied or x['kind'] in {'Return','Raise','Break','Continue'} for x in chunk):
                        raise ValueError(f'{filename}: groups must cover disjoint adjacent ordinary statements in one lane: {path}::{scope}')
                    title = field(group, 'title', 100)
                    if not title:
                        raise ValueError(f'{filename}: groups need a title for {path}::{scope}')
                    occupied.update(x['id'] for x in chunk)
                    clean['groups'].append({'first': group['first'], 'last': group['last'], 'title': title, 'summary': field(group, 'summary', 240)})
                for step, note in steps.items():
                    if step not in matches or not isinstance(note, dict):
                        raise ValueError(f'{filename}: unknown step {path}::{scope}::{step}')
                    clean['steps'][step] = {key: field(note, key, limit) for key, limit in [('title', 100), ('summary', 800), ('detail', 3000)]}
                file['notes'][scope] = clean


def render(project):
    encoded = dump(project.data).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e')
    replace = {'CSS': (ASSETS / 'style.css').read_text(encoding='utf-8-sig'), 'JS': '\n'.join((ASSETS / name).read_text(encoding='utf-8-sig') for name in ('graph.js', 'viewer.js')), 'DATA': encoded}
    import re
    return re.sub(r'@@(CSS|JS|DATA)@@', lambda m: replace[m[1]], (ASSETS / 'site.html').read_text(encoding='utf-8-sig'))


def reached_through_link(path):
    """True when an existing component of path is a symlink or junction.

    Checks each component directly instead of comparing Path.resolve() to the
    input: on Windows resolve() also expands 8.3 short names (C:\\Users\\RUNNER~1),
    which would reject perfectly ordinary output directories such as %TEMP%.
    """
    for part in reversed([path, *path.parents]):
        try:
            os.readlink(part)
        except OSError:
            continue
        return True
    return False


def write_output(path, content, force, suffix):
    path = Path(os.path.abspath(path))
    if reached_through_link(path):
        raise ValueError('Choose an output directory that is not reached through a symlink or junction')
    if path.suffix.lower() != suffix:
        raise ValueError(f'Output must have a {suffix} extension')
    if path.is_symlink() or path.is_dir() or (path.exists() and not force):
        raise ValueError(f'Output already exists (use --force for a regular file): {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.tmp', delete=False) as stream:
            temp = Path(stream.name)
            stream.write(content.encode('utf-8'))
        if force:
            os.replace(temp, path)
        else:
            # Publish without replacing an existing file (including a racing writer).
            os.link(temp, path)
    finally:
        if temp:
            temp.unlink(missing_ok=True)


def inspect(project, file_path, symbol, from_line, limit):
    file = project.data['files'][file_path]
    symbols = {s['id']: s for s in file['symbols']}
    if symbol not in {MODULE, *symbols}:
        raise ValueError(f'Unknown symbol: {symbol}. Available: ' + ', '.join(symbols))
    info = symbols.get(symbol)
    lines = split_source(file['source'], file['language'])
    low, high = (info['start'], info['end']) if info else (1, len(lines))
    first = from_line or low
    if from_line is not None and not low <= first <= high:
        raise ValueError(f'--from-line is outside scope L{low}–{high}')
    last = min(high, first + limit - 1)
    steps = [s for s in flatten(file['flows'].get(symbol, [])) if s['end'] >= first and s['start'] <= last]
    return {'path': file_path, 'language': file['language'], 'sha256': file['sha256'], 'scope': symbol, 'range': [low, high], 'next_line': last + 1 if last < high else None,
            'symbols': [s for s in file['symbols'] if first <= s['line'] <= last], 'error': file.get('error'),
            'source': [[i, lines[i - 1]] for i in range(first, last + 1)],
            'steps': [{k: s[k] for k in ('id', 'start', 'end', 'kind', 'label', 'calls')} for s in steps]}


def relarg(value):
    p = PurePosixPath(value.replace('\\', '/'))
    if p.is_absolute() or '..' in p.parts or str(p) == '.' or ':' in p.parts[0]:
        raise argparse.ArgumentTypeError('Use a project-relative path')
    return str(p)


def positive(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError('Must be greater than zero')
    return number


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='command', required=True)
    for mode in ('scan', 'inspect', 'build'):
        command = subs.add_parser(mode, help={'scan': 'Show project metadata, no source output', 'inspect': 'Show a bounded line-numbered source slice', 'build': 'Export standalone HTML'}[mode])
        command.add_argument('root', type=Path, nargs='?', default=Path('.'))
        command.add_argument('--exclude', action='append', type=relarg, default=[], help='Exclude an exact project-relative path/subtree')
        command.add_argument('--focus', action='append', type=relarg, default=[], help='Prioritize embedding a project-relative source file; repeatable')
        command.add_argument('--language', choices=['auto', 'python', 'typescript'], default='auto', help='Choose source languages to analyze (default: auto)')
        command.add_argument('--max-files', type=positive, default=1000)
        command.add_argument('--max-file-bytes', type=positive, default=1_000_000)
        command.add_argument('--budget-bytes', type=positive, default=12_000_000)
        if mode == 'build':
            command.add_argument('--out', type=Path, default=Path('output/index.html'), help='Output relative to current working directory')
            command.add_argument('--analysis-out', type=Path, help='Also save the versioned analysis data as JSON')
            command.add_argument('--notes', type=Path, action='append', default=[])
            command.add_argument('--force', action='store_true')
        elif mode == 'inspect':
            command.add_argument('--file', required=True, type=relarg)
            command.add_argument('--symbol', default=MODULE, help='Exact qualified symbol ID; default is file scope')
            command.add_argument('--from-line', type=positive)
            command.add_argument('--limit', type=positive, default=120, help='Max number of lines to include (default 120)')
        else:
            command.add_argument('--paths', action='store_true', help='Include the complete tree in JSON')
    args = parser.parse_args(argv)
    try:
        omit = []
        if args.command == 'build':
            for location in [args.out, *args.notes, *([args.analysis_out] if args.analysis_out else [])]:
                if location.resolve().is_relative_to(args.root.resolve()):
                    omit.append(location.resolve().relative_to(args.root.resolve()).as_posix())
        focus = list(dict.fromkeys(([args.file] if args.command == 'inspect' else []) + args.focus))
        only_flows = {'scan': set, 'inspect': lambda: {(args.file, args.symbol)}, 'build': lambda: None}[args.command]()
        project = Project(args.root, excludes=args.exclude, focuses=focus, max_files=args.max_files, max_file_bytes=args.max_file_bytes, budget_bytes=args.budget_bytes, omit=omit, only_flows=only_flows, language=args.language)
        data = project.data
        if args.command == 'inspect':
            print(json.dumps(inspect(project, args.file, args.symbol, args.from_line, args.limit), ensure_ascii=False, indent=2))
        elif args.command == 'scan':
            counts = Counter(entry['kind'] for entry in data['tree'])
            print(json.dumps({'name': data['name'], 'counts': dict(counts), 'embedded': len(data['files']),
                              'entries': [{'path': p, 'reasons': f['entry']} for p, f in data['files'].items() if f['entry']],
                              'reading': data['reading'], 'dependency_count': len(data['dependencies']),
                              'parse_errors': [p for p, f in data['files'].items() if f.get('error')],
                              'warnings': data['warnings'], **({'tree': data['tree']} if args.paths else {})}, ensure_ascii=False, indent=2))
        else:
            load_notes(project, args.notes)
            write_output(args.out, render(project), args.force, '.html')
            if args.analysis_out:
                write_output(args.analysis_out, dump(data) + '\n', args.force, '.json')
            totals = Counter(entry['kind'] for entry in data['tree'])
            included = Counter(file['language'] for file in data['files'].values())
            coverage = ' | '.join(f'{lang}: {included[lang]}/{totals[lang]}' for lang in dict.fromkeys(SOURCE_KINDS.values()) if totals[lang]) or 'No supported source files'
            errors = sum(bool(f.get('error')) for f in data['files'].values())
            print(f'{args.out.resolve()} | {coverage} | AST errors: {errors} | warnings: {len(data["warnings"])}')
    except (ValueError, OSError, RecursionError) as exc:
        parser.exit(1, f'CodeLens: {exc}\n')
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
        sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    raise SystemExit(cli())
