from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
SCRIPT = BASE / 'codelens' / 'scripts' / 'codelens.py'
sys.path.insert(0, str(SCRIPT.parent))
from analyzer import MODULE, Project, flatten, split_source
from codelens import inspect, load_notes, reached_through_link, render


def payload(html):
    return json.loads(re.search(r'<script id="model-data" type="application/json">(.*?)</script>', html, re.S).group(1))


class Fixture(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.add('src/pkg/__init__.py', '')
        self.add('src/pkg/ops.py', 'def transform(data):\n    return data + 1\n\ndef decorator(fn):\n    return fn\n')
        self.add('src/pkg/main.py', '''from .ops import transform as run_transform, decorator
from . import ops
import pkg.ops
import pkg.ops as helpers

@decorator
def main(x):
    if x > 0:
        return run_transform(x)
    return ops.transform(x)

def shadow(run_transform):
    return run_transform(0)

def other():
    return helpers.transform(3) + pkg.ops.transform(2)

if __name__ == "__main__":
    main(4)
''')
        self.add('pyproject.toml', '[project.scripts]\ndemo = "pkg.main:main"\n')

    def add(self, path, data):
        item = self.root / path
        item.parent.mkdir(parents=True, exist_ok=True)
        item.write_bytes(data.encode('utf-8') if isinstance(data, str) else data)
        return item

    def test_symbol_and_flow_ranges(self):
        project = Project(self.root)
        file = project.data['files']['src/pkg/main.py']
        symbol = next(s for s in file['symbols'] if s['id'] == 'main')
        self.assertEqual((symbol['start'], symbol['line'], symbol['end']), (6, 7, 10))
        steps = list(flatten(file['flows']['main']))
        self.assertEqual([(s['start'], s['end'], s['kind']) for s in steps],
                         [(8, 9, 'If'), (9, 9, 'Return'), (10, 10, 'Return')])
        self.assertEqual(steps[0]['lanes'][0]['steps'][0]['id'], '9:8')
        self.assertTrue(any('project.toml' in entry for entry in file['entry']))
        self.assertTrue(any('guard' in entry for entry in file['entry']))
        info = inspect(project, file['path'], 'main', None, 2)
        self.assertEqual((info['source'][0], info['next_line']), ([6, '@decorator'], 8))

    def test_multiline_decorator_and_local_definition(self):
        self.add('nested.py', '@(\n  wrap\n)\ndef outer():\n    def local():\n        pass\n    return local()\n')
        file = Project(self.root).data['files']['nested.py']
        outer = file['symbols'][0]
        self.assertEqual((outer['start'], outer['line'], outer['end']), (1, 4, 7))
        self.assertEqual(file['flows'][MODULE][0]['start'], 1)
        self.assertEqual(file['flows']['outer'][1]['calls'][0]['target']['line'], 5)

    def test_aliases_upstream_and_shadowing(self):
        project = Project(self.root)
        flows = project.data['files']['src/pkg/main.py']['flows']
        for name in ('main', 'other'):
            calls = [c for s in flatten(flows[name]) for c in s['calls']]
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(c['status'] == 'static' and c['target'] == {'path': 'src/pkg/ops.py', 'symbol': 'transform', 'line': 1} for c in calls))
        self.assertEqual(flows['shadow'][0]['calls'][0]['status'], 'unknown')
        self.assertEqual([c['line'] for c in project.reverse[('src/pkg/ops.py', 'transform')]], [9, 10, 16, 16])
        edge = {'from': 'src/pkg/main.py', 'to': 'src/pkg/ops.py', 'count': 4}
        self.assertIn(edge, project.data['dependencies'])

    def test_dynamic_and_ambiguous_are_not_asserted(self):
        self.add('pkg/ops.py', 'def transform(data):\n    return data - 1\n')
        self.add('extra.py', '''
def f():
    return 1

class X:
    def a(self):
        return self.b()
    def b(self):
        return 2

def dynamic(it):
    return [f() for f in it]

f = lambda: 5
''')
        data = Project(self.root).data['files']
        self.assertEqual(data['src/pkg/main.py']['flows']['main'][0]['lanes'][0]['steps'][0]['calls'][0]['status'], 'unknown')
        self.assertEqual(data['extra.py']['flows']['X.a'][0]['calls'][0]['status'], 'candidate')
        self.assertEqual(data['extra.py']['flows']['dynamic'][0]['calls'][0]['status'], 'unknown')

    def test_private_paths_focus_budgets_and_invalid_syntax(self):
        self.add('.env', 'secret')
        self.add('secrets.py', 'private = 1')
        self.add('.venv/site.py', 'private = 2')
        self.add('kept/raw.txt', 'not embedded')
        self.add('excluded/data.py', 'huge = 1')
        invalid = 'def broken(\n'
        self.add('broken.py', invalid)
        data = Project(self.root, max_files=1, focuses=['broken.py'], excludes=['excluded']).data
        self.assertEqual(set(data['files']), {'broken.py'})
        self.assertEqual(data['files']['broken.py']['source'], invalid)
        self.assertIn('error', data['files']['broken.py'])
        tree = {x['path']: x for x in data['tree']}
        self.assertNotIn('.env', tree)
        self.assertNotIn('secrets.py', tree)
        self.assertNotIn('excluded', tree)
        self.assertIn('kept/raw.txt', tree)
        self.assertIn('status', tree['src/pkg/main.py'])
        self.assertNotIn('not embedded', json.dumps(data))

    def test_source_encoding_and_inert_html(self):
        raw = b'# coding: cp1252\r\nword = "caf\xe9 </script>"\r\n'
        self.add('encoded.py', raw)
        source = '# literal\nvalue = "\U0001f30e\u2028" + "x"\n\n'
        self.add('unicode.py', source)
        project = Project(self.root)
        html = render(project)
        data = payload(html)
        self.assertEqual(data['files']['encoded.py']['source'], raw.decode('cp1252').replace('\r\n', '\n'))
        self.assertEqual(data['files']['encoded.py']['sha256'], sha256(raw).hexdigest())
        self.assertEqual(data['files']['unicode.py']['source'], source)
        self.assertEqual(data['files']['unicode.py']['syntax']["2"][-1], [16, 19, 'str'])
        self.assertEqual(len(split_source(source)), 3)
        self.assertEqual(html.count('</script>'), 2)

    def test_notes_validation_and_reuse(self):
        project = Project(self.root)
        path = 'src/pkg/main.py'
        notes = {'version': 1, 'reading': [{'path': path, 'reason': 'Start at main'}], 'files': {path: {
            'sha256': project.data['files'][path]['sha256'], 'scopes': {'main': {'steps': {'9:8': {'title': 'Apply transform'}}}}}}}
        filename = self.add('notes.json', json.dumps(notes))
        load_notes(project, [filename])
        self.assertEqual(project.data['reading'][0]['path'], path)
        self.assertEqual(project.data['files'][path]['notes']['main']['steps']['9:8']['title'], 'Apply transform')
        notes['files'][path]['scopes']['main']['steps'] = {'999:8': {}}
        filename.write_text(json.dumps(notes), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'unknown step'):
            load_notes(project, [filename])
        notes['files'][path]['sha256'] = 'not-the-same-source'
        filename.write_text(json.dumps(notes), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'source absent or changed'):
            load_notes(project, [filename])

    def test_analysis_sidecar_matches_embedded_model(self):
        html, data = self.root / 'out/index.html', self.root / 'out/analysis.json'
        command = [sys.executable, '-B', str(SCRIPT), 'build', str(self.root), '--out', str(html), '--analysis-out', str(data)]
        subprocess.run(command, capture_output=True, check=True)
        self.assertEqual(payload(html.read_text(encoding='utf-8')), json.loads(data.read_text(encoding='utf-8')))
        self.assertNotIn('out/index.html', {x['path'] for x in payload(html.read_text(encoding='utf-8'))['tree']})

    def test_output_guard_uses_real_links_not_name_expansion(self):
        # Ordinary directories are writable even when their text form differs from
        # the resolved path (Windows 8.3 short names such as C:\Users\RUNNER~1,
        # or a not-yet-created output folder).
        self.assertFalse(reached_through_link(Path(os.path.abspath(self.root)) / 'out' / 'index.html'))
        target, alias = self.root / 'real-out', self.root / 'out-alias'
        target.mkdir()
        if os.name == 'nt':
            made = subprocess.run(['cmd', '/c', 'mklink', '/J', str(alias), str(target)], capture_output=True)
        else:
            made = subprocess.run([sys.executable, '-c', 'import os,sys; os.symlink(sys.argv[1], sys.argv[2], target_is_directory=True)', str(target), str(alias)], capture_output=True)
        if made.returncode != 0:
            self.skipTest('symlinks and junctions are unavailable here')
        self.assertTrue(reached_through_link(alias / 'index.html'))
        command = [sys.executable, '-B', str(SCRIPT), 'build', str(self.root), '--out', str(alias / 'index.html')]
        done = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(done.returncode, 1)
        self.assertIn('not reached through a symlink or junction', done.stderr)
        self.assertFalse((target / 'index.html').exists())

    def test_packaged_installations_and_end_to_end_cli(self):
        for agent, folder in [('codex', '.agents'), ('claude', '.claude'), ('deepseek', '.dsh')]:
            args = [sys.executable, '-B', str(BASE / 'install.py'), '--agent', agent, '--project', str(self.root)]
            subprocess.run(args, capture_output=True, check=True)
            target = self.root / folder / 'skills/codelens'
            self.assertTrue((target / 'SKILL.md').read_text(encoding='utf-8').startswith('---\nname: codelens\n'))
            self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
            built = self.root / f'{agent}.html'
            command = [sys.executable, '-B', str(target / 'scripts/codelens.py'), 'build', str(self.root), '--out', str(built)]
            subprocess.run(command, capture_output=True, check=True)
            self.assertIn('src/pkg/main.py', payload(built.read_text(encoding='utf-8'))['files'])
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


class Nanochat(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('CODELENS_NANOCHAT_ROOT'), 'set CODELENS_NANOCHAT_ROOT for real-repo regression')
    def test_real_source_snapshot(self):
        root = Path(os.environ['CODELENS_NANOCHAT_ROOT'])
        project = Project(root)
        model = project.data
        self.assertEqual(len(model['files']), 36)
        self.assertEqual(len(model['dependencies']), 80)
        for path, file in model['files'].items():
            raw = (root / path).read_bytes()
            self.assertEqual(file['sha256'], sha256(raw).hexdigest())
            self.assertEqual(file['source'], raw.decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n'))
            self.assertNotIn('error', file)
            max_line = len(split_source(file['source']))
            for steps in file['flows'].values():
                for step in flatten(steps):
                    self.assertTrue(1 <= step['start'] <= step['end'] <= max_line, (path, step))
        train = model['files']['scripts/base_train.py']['flows'][MODULE]
        node = next(n for n in flatten(train) if n['start'] == 426)
        self.assertEqual(node['calls'][0]['target'], {'path': 'nanochat/loss_eval.py', 'symbol': 'evaluate_bpb', 'line': 8})
        self.assertEqual(next(n for n in flatten(train) if n['start'] == 511)['calls'][0]['status'], 'unknown')
        load_notes(project, [BASE / 'examples/nanochat-notes.json'])
        self.assertEqual(payload(render(project))['reading'][0]['path'], 'scripts/base_train.py')


if __name__ == '__main__':
    unittest.main()
