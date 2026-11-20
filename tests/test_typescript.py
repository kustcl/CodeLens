from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_core import BASE, SCRIPT, MODULE, Project, flatten, inspect, payload, render, split_source

DEMO = BASE / 'examples' / 'typescript-demo'
PARSER = SCRIPT.parent / 'node_modules/typescript/package.json'


@unittest.skipUnless(shutil.which('node') and PARSER.is_file(), 'Install the optional TypeScript parser to run these tests')
class TypeScript(unittest.TestCase):
    def test_demo_mapping_and_inspect(self):
        p = Project(DEMO)
        main = p.data['files']['src/main.ts']
        self.assertEqual(main['language'], 'typescript')
        self.assertEqual(main['symbols'][0]['kind'], 'async')
        self.assertEqual(main['sha256'], sha256((DEMO / main['path']).read_bytes()).hexdigest())
        steps = list(flatten(main['flows']['main']))
        kinds = {s['kind'] for s in steps}
        self.assertTrue({'If', 'For', 'Try', 'Continue', 'Return'} <= kinds)
        score = next(s['calls'][0] for s in steps if s['start'] == 12)
        self.assertEqual(score['target'], {'path': 'src/score.ts', 'symbol': 'normalize', 'line': 7})
        self.assertEqual(score['status'], 'static')
        self.assertIn({'path': 'src/main.ts', 'symbol': 'main', 'line': 12, 'status': 'static'}, p.data['incoming'][0]['calls'])
        self.assertEqual(next(s['calls'][0]['status'] for s in steps if s['start'] == 17), 'unknown')
        self.assertFalse(p.data['files']['src/score.ts']['flows'][MODULE][0].get('calls'))
        only = Project(DEMO, only_flows={('src/main.ts', 'main')})
        self.assertEqual(set(only.data['files']['src/main.ts']['flows']), {'main'})
        self.assertEqual(only.data['files']['src/score.ts']['flows'], {})
        self.assertNotIn('syntax', only.data['files']['src/main.ts'])
        self.assertEqual(inspect(only, 'src/main.ts', 'main', 12, 1)['steps'][-1]['calls'][0], score)
        self.assertTrue(all(not f['flows'] for f in Project(DEMO, only_flows=set()).data['files'].values()))

    def test_tsx_offsets_and_exact_source(self):
        p = Project(DEMO)
        f = p.data['files']['src/badge.tsx']
        self.assertEqual(f['source'], (DEMO / f['path']).read_text(encoding='utf-8'))
        raw = split_source(f['source'], f['language'])[5].encode('utf-16-le')
        highlight = {(raw[a*2:b*2].decode('utf-16-le'), tag) for a,b,tag in f['syntax']['6']}
        self.assertTrue({('return','kw'), ('span','kw'), ('"分数"','str'), ('}','op')} <= highlight)
        self.assertEqual(payload(render(p)), p.data)

    def test_mixed_project_resolution_and_safe_fallbacks(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root/'lib.mts').write_text('export const one = () => 1;\nexport let change = () => 2;', encoding='utf-8')
            (root/'barrel.mts').write_text('export { one } from "./lib.mjs";', encoding='utf-8')
            (root/'run.cts').write_text('''import { one } from "./barrel.mjs";
import { change } from "./lib.mjs";
import type { one as typeOnly } from "./lib.mjs";
import * as ns from "./lib.mjs";
import { one as external } from "../../lib.mjs";
function replacement() { return 3; }
function assigned() { return 4; }
assigned = replacement;
@register
class Box {
  constructor() {}
  value() { return one(); }
}
export function main(one: () => number) {
  try {
    return one() + ns.one() + change() + typeOnly() + external() + assigned() + new Box().value();
  } finally {
    console.log("done");
  }
}
''', encoding='utf-8')
            (root/'other.py').write_text('print("ok")\n', encoding='utf-8')
            (root/'ambient.d.ts').write_text('export declare function fake(): number;\n', encoding='utf-8')
            (root/'bad.ts').write_text('const = broken\n', encoding='utf-8')
            p = Project(root)
            files = p.data['files']
            self.assertEqual(files['other.py']['language'], 'python')
            self.assertEqual(files['ambient.d.ts']['flows'][MODULE], [])
            self.assertIn('error', files['bad.ts'])
            self.assertEqual(files['bad.ts']['flows'], {})
            f = files['run.cts']
            self.assertEqual([s['decorators'] for s in f['symbols'] if s['id']=='Box'], [['@register']])
            self.assertIn('Box.value', f['flows'])
            sites = {c['name']: c for s in flatten(f['flows']['main']) for c in s['calls']}
            for name in ('one','change','typeOnly','external','assigned','new Box().value'):
                self.assertEqual(sites[name]['status'], 'unknown', name)
            self.assertEqual(sites['ns.one']['target']['path'], 'lib.mts')
            self.assertEqual(sites['Box']['target']['symbol'], 'Box.constructor')
            self.assertEqual(f['flows']['Box.value'][0]['calls'][0]['target']['path'], 'lib.mts')
            self.assertEqual(f['flows']['main'][0]['lanes'][-1]['line'], 17)
            self.assertEqual(set(Project(root, language='python').data['files']), {'other.py'})
            self.assertNotIn('other.py', Project(root, language='typescript').data['files'])

    def test_cli(self):
        with tempfile.TemporaryDirectory() as d:
            html, analysis = (Path(d)/name for name in ('index.html','analysis.json'))
            args = [sys.executable, '-B', str(SCRIPT), 'build', str(DEMO), '--out', str(html), '--analysis-out', str(analysis)]
            done = subprocess.run(args, capture_output=True, check=True, encoding='utf-8')
            self.assertIn('typescript: 3/3', done.stdout)
            self.assertEqual(payload(html.read_text(encoding='utf-8')), json.loads(analysis.read_text(encoding='utf-8')))


if __name__ == '__main__':
    unittest.main()