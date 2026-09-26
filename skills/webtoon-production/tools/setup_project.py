"""웹툰 작품 저장소에 webtoon-production 도구를 연결한다.

  python3 ~/Projects/agent-skills/skills/webtoon-production/tools/setup_project.py <작품 루트> --name "작품 이름"

- production/project.json, production/프롬프트-템플릿.json: 없으면 템플릿에서 만든다. 있으면 건드리지 않는다.
- tools, tests, production/README.md: 스킬의 원본을 가리키는 심링크. 이미 실제 폴더/파일이면 --replace 없이는 바꾸지 않는다.
- AGENTS.md: 도구 안내가 없으면 끝에 덧붙인다(기존 내용은 유지). 제목이 달라도 스킬 경로가
  이미 적혀 있으면 안내가 있는 것으로 보고 덧붙이지 않는다.
"""
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
SECTION_MARK = '## 회차 제작 도구 — webtoon-production'
# 문구를 고쳐 쓴 작품 지침에도 중복 추가하지 않도록 스킬 경로로도 판정한다.
SKILL_REF = 'skills/webtoon-production'
SECTION = f'''
{SECTION_MARK}

회차 제작·콘티·컷 생성·검수는 공용 스킬 `~/Projects/agent-skills/skills/webtoon-production/`의 도구를 쓴다(`tools/`·`tests/`·`production/README.md`는 그 스킬로 가는 심링크). 절차와 명령은 `production/README.md`, 이 작품의 검수 항목은 `production/project.json`, 컷 프롬프트 공통 블록은 `production/프롬프트-템플릿.json`이다. 흐름: 관리 파일 작성 → `panel.py batch --stage draft` → `verdict` → `batch --stage final`(OCR 경고 확인) → `adopt` → `screen` → `production.py review` → 납품. 생성은 항상 새 버전 파일이며 첨부 수를 로그로 대조한다. 도구 검증: `python3 -m unittest discover -s tests -p 'test_p*.py' -v`.
'''


def link(target, source, replace, made):
    """target이 source를 가리키는 심링크가 되게 한다."""
    if target.is_symlink():
        if target.resolve() == source.resolve():
            return
        if not replace:
            raise SystemExit(f'{target}가 다른 곳을 가리킵니다: {os.readlink(target)} (--replace로 교체)')
        target.unlink()
    elif target.exists():
        if not replace:
            raise SystemExit(f'{target}가 실제 파일/폴더입니다. 내용이 스킬과 같은지 확인한 뒤 --replace로 교체하세요.')
        backup = target.with_name(target.name + '.교체전')
        if backup.exists():
            raise SystemExit(f'{backup}이 이미 있습니다.')
        target.rename(backup)
        made.append(f'보존: {backup.relative_to(target.parents[len(target.parents) - 1]) if False else backup}')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(os.path.relpath(source, target.parent))
    made.append(f'링크: {target} → {os.readlink(target)}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('root')
    parser.add_argument('--name', help='작품 이름(project.json·템플릿에 기록). 새로 만들 때 필수')
    parser.add_argument('--replace', action='store_true', help='실제 tools/tests/README가 있으면 .교체전으로 이름을 바꾸고 심링크로 교체')
    parser.add_argument('--no-agents', action='store_true', help='AGENTS.md를 건드리지 않는다')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if not root.is_dir():
        raise SystemExit(f'폴더 없음: {root}')
    made = []
    prod = root / 'production'
    prod.mkdir(exist_ok=True)
    for name in ('project.json', '프롬프트-템플릿.json'):
        target = prod / name
        if target.exists():
            continue
        if not args.name:
            raise SystemExit(f'{target}를 만들려면 --name이 필요합니다.')
        data = json.loads((SKILL / 'templates' / name).read_text(encoding='utf-8'))
        data['project'] = args.name
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        made.append(f'생성: {target} (내용을 작품에 맞게 채울 것)')
    link(root / 'tools', SKILL / 'tools', args.replace, made)
    link(root / 'tests', SKILL / 'tests', args.replace, made)
    link(prod / 'README.md', SKILL / 'README.md', args.replace, made)
    agents = root / 'AGENTS.md'
    if not args.no_agents:
        text = agents.read_text(encoding='utf-8') if agents.exists() else ''
        if SECTION_MARK in text or SKILL_REF in text:
            made.append(f'유지: {agents} 이미 도구 안내가 있음')
        else:
            with agents.open('a', encoding='utf-8') as stream:
                stream.write(('' if text.endswith('\n') or not text else '\n') + SECTION)
            made.append(f'추가: {agents} 도구 안내 절')
    for line in made:
        print(line)
    print('확인: cd', root, '&& python3 tools/production.py --help')
    return 0


if __name__ == '__main__':
    sys.exit(main())
