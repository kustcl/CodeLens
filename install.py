"""Install the portable CodeLens bundle into a project skill directory."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil

ROOTS = {'codex': '.agents/skills', 'claude': '.claude/skills', 'deepseek': '.dsh/skills'}
SOURCE = Path(__file__).resolve().parent / 'codelens'


def install(root, agent):
    if not root.is_dir():
        raise ValueError(f'Project directory does not exist: {root}')
    target = root.resolve() / ROOTS[agent] / 'codelens'
    if target.exists() or target.is_symlink():
        raise FileExistsError(f'Existing installation not modified: {target}')
    # Do not write through an existing skill-root symlink or junction outside the project.
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Skill directory resolves outside project: {target}')
    shutil.copytree(SOURCE, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'node_modules'))
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent', required=True, choices=ROOTS)
    parser.add_argument('--project', type=Path, default=Path('.'))
    args = parser.parse_args()
    try:
        print(install(args.project, args.agent))
    except (ValueError, OSError) as error:
        parser.exit(1, f'CodeLens: {error}\n')


if __name__ == '__main__':
    main()
