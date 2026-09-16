"""웹툰 회차의 콘티·분업·검수 이력을 관리한다. 생성과 공개는 실행하지 않는다."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from datetime import datetime, timezone



def find_root(explicit=None):
    """작품 저장소 루트: --root > WEBTOON_ROOT > 현재 위치에서 위로 올라가며 production/project.json이 있는 곳."""
    import os
    if explicit or os.environ.get('WEBTOON_ROOT'):
        root = Path(explicit or os.environ['WEBTOON_ROOT']).resolve()
        if not (root / 'production/project.json').is_file():
            raise ValueError(f'{root}에 production/project.json이 없습니다.')
        return root
    here = Path.cwd().resolve()
    for candidate in (here, *here.parents):
        if (candidate / 'production/project.json').is_file():
            return candidate
    raise ValueError('작품 저장소 안에서 실행하세요(production/project.json이 있는 폴더 또는 그 아래). '
                     '새 작품은 webtoon-production 스킬의 tools/setup_project.py로 시작합니다.')


ROOT = None


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def path(root, value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('파일 경로가 비어 있습니다.')
    result = (root / value).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError('파일은 작품 저장소 안에 있어야 합니다.')
    return result


def read(file):
    return json.loads(file.read_text(encoding='utf-8'))


def create(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def required(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{label}: 내용을 입력하세요.')


STORY_FIELDS = ('canon', 'start_state', 'knowledge', 'end_state',
                'foreshadowing', 'authority', 'review_note')


def init_story(root, data):
    """선별 도입 작품의 신규 회차에만 서사 기록을 추가한다. 구회차는 이식하지 않는다."""
    policy_file = root / 'production/story-policy.json'
    if not policy_file.exists():
        return
    policy = read(policy_file)
    if policy.get('version') != 1 or type(policy.get('from_episode')) is not int or policy['from_episode'] < 1:
        raise ValueError('story-policy.json의 version=1 및 양의 from_episode가 필요합니다.')
    if data['episode'] < policy['from_episode']:
        return
    guide = policy.get('guide')
    if not path(root, guide).is_file():
        raise ValueError('작품별 서사 안내 파일이 없습니다.')
    data['brief']['story'] = dict.fromkeys(STORY_FIELDS, '')
    if guide not in data['references']:
        data['references'].append(guide)
    data['schedule']['story_metrics'] = dict.fromkeys(
        ['post_script_changed_panels', 'generation_calls_per_adopted_panel',
         'resume_minutes', 'documentation_minutes', 'redundant_approval_questions'], None)


def validate_story(brief):
    # 이 필드가 없는 기존 파일의 해시·검수 조건은 그대로 둔다.
    if 'story' not in brief:
        return
    if not isinstance(brief['story'], dict):
        raise ValueError('brief.story는 서사 기록 객체여야 합니다.')
    for key in STORY_FIELDS:
        required(brief['story'].get(key), f'brief.story.{key}')


def validate(data, config):
    if data['schema'] != 1 or data['project'] != config['project']:
        raise ValueError('다른 작품 또는 지원하지 않는 회차 형식입니다.')
    if type(data['episode']) is not int or data['episode'] < 1:
        raise ValueError('회차는 양의 정수여야 합니다.')
    if not data['panels']:
        raise ValueError('최소 한 컷이 필요합니다.')
    ids = [p['id'] for p in data['panels']]
    if ids != [f'{i:02}' for i in range(1, len(ids) + 1)]:
        raise ValueError('컷 ID는 01부터 빠짐없이 순서대로 지정하세요.')


def hashes(root, refs):
    return {ref: hashlib.sha256(path(root, ref).read_bytes()).hexdigest() for ref in refs}


def fingerprint(root, data, config, target):
    validate(data, config)
    brief = data['brief']
    for key in ('premise', 'turn', 'ending', 'research_note'):
        required(brief[key], key)
    validate_story(brief)
    base = {'project': data['project'], 'episode': data['episode'], 'brief': brief,
            'references': hashes(root, data['references']), 'rules': config}
    if target == 'brief':
        return digest(base)
    for panel in data['panels']:
        for key in ('scene', 'emotion', 'shot', 'owner'):
            required(panel[key], f"{panel['id']} {key}")
        if not isinstance(panel['dialogue'], list) or any(not isinstance(x, str) for x in panel['dialogue']):
            raise ValueError('대사는 문자열 목록이어야 합니다. 무대사는 빈 목록입니다.')
    story = [{k: v for k, v in p.items() if k not in ('source', 'output')} for p in data['panels']]
    if target == 'storyboard':
        return digest([base, story])
    panel = next((p for p in data['panels'] if p['id'] == target), None)
    if panel is None:
        raise ValueError('없는 검수 대상입니다.')
    # 한 컷 수정은 그 컷만 무효화한다. 공통 설정 수정은 모든 컷을 무효화한다.
    return digest([base, panel, hashes(root, [panel['source'], panel['output']])])


def receipt_valid(root, data, config, target):
    try:
        value = fingerprint(root, data, config, target)
    except (ValueError, OSError, KeyError, TypeError):
        return False
    return any(r.get('target') == target and r.get('fingerprint') == value
               and r.get('reviewer') and r.get('note')
               and r.get('checks') == checklist(config, target)
               for r in data['reviews'])


def checklist(config, target):
    return config['checks'][target if target in ('brief', 'storyboard') else 'panel']


def prerequisites(root, data, config, target):
    deps = [] if target == 'brief' else ['brief']
    if target not in ('brief', 'storyboard'):
        deps.append('storyboard')
    for dep in deps:
        if not receipt_valid(root, data, config, dep):
            raise ValueError(f'{dep} 검수 또는 재검수가 먼저 필요합니다.')


def delivery(root, data, config):
    from PIL import Image
    total = 0
    outputs = set()
    for panel in data['panels']:
        output = path(root, panel['output'])
        if output in outputs or output.name != f"{panel['id']}.jpg":
            raise ValueError('납품본은 중복 없이 컷 번호.jpg로 지정하세요.')
        outputs.add(output)
        size = output.stat().st_size
        total += size
        with Image.open(output) as im:
            im.load()
            if im.format != 'JPEG' or im.width != config['delivery']['width'] or im.mode != 'RGB':
                raise ValueError(f"{panel['id']}: RGB JPEG / 지정 가로 크기 불일치")
        if size >= config['delivery']['file_bytes_exclusive']:
            raise ValueError(f"{panel['id']}: 파일 용량 초과")
    if total > config['delivery']['episode_bytes_inclusive']:
        raise ValueError('회차 전체 용량 초과')
    return total


def report(root, data, config, stage):
    validate(data, config)
    targets = ['brief']
    if stage != 'brief':
        targets.append('storyboard')
    if stage in ('production', 'delivery'):
        targets += [p['id'] for p in data['panels']]
    pending = [t for t in targets if not receipt_valid(root, data, config, t)]
    result = {'project': data['project'], 'episode': data['episode'], 'stage': stage,
              'pending': pending, 'ready': not pending,
              'schedule': data['schedule'], 'publication': '공개 발행 권한과 별개'}
    if 'story' in data['brief']:
        try:
            validate_story(data['brief'])
            result['story_record'] = '필수 기록 있음. 의미·승인·재미는 검수자가 확인해야 함'
        except ValueError as error:
            result['story_record'] = str(error)
    if not pending and stage == 'delivery':
        result['bytes'] = delivery(root, data, config)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', help='작품 저장소 루트(기본: 현재 위치에서 탐색)')
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init', help='새 회차 관리 파일 생성, 기존 파일 덮어쓰기 금지')
    init.add_argument('manifest')
    init.add_argument('--episode', type=int, required=True)
    init.add_argument('--panels', type=int, default=1)
    init.add_argument('--from-storyboard', help='기존 panel_specs 콘티를 복사해 연결')
    check = sub.add_parser('check', help='통과 0, 미완료/오류 1')
    check.add_argument('manifest')
    check.add_argument('--stage', choices=['brief', 'storyboard', 'production', 'delivery'], default='delivery')
    review = sub.add_parser('review', help='실제 검수 후 현재 내용의 해시를 기록')
    review.add_argument('manifest')
    review.add_argument('--target', required=True, help='brief, storyboard 또는 01 같은 컷 ID')
    review.add_argument('--reviewer', required=True)
    review.add_argument('--note', required=True)
    review.add_argument('--confirm', action='append', default=[], help='검수한 항목 이름. 모든 항목을 각각 지정')
    args = parser.parse_args()
    global ROOT
    ROOT = find_root(args.root)
    config = read(ROOT / 'production/project.json')
    manifest = path(ROOT, args.manifest)
    if args.command == 'init':
        if args.episode < 1 or args.panels < 1:
            raise ValueError('회차와 컷 수는 양수여야 합니다.')
        specs = None
        if args.from_storyboard:
            specs = read(path(ROOT, args.from_storyboard))['panel_specs']
        panels = []
        for i in range(len(specs) if specs is not None else args.panels):
            old = specs[i] if specs is not None else {}
            panels.append({'id': f'{i+1:02}', 'scene': old.get('scene', ''),
                           'dialogue': old.get('text', []), 'emotion': old.get('emotion', ''),
                           'shot': old.get('shot', ''), 'owner': '', 'source': '', 'output': ''})
        data = {'schema': 1, 'project': config['project'], 'episode': args.episode,
                'brief': dict.fromkeys(['premise', 'turn', 'ending', 'research_note'], ''),
                'references': config['references'],
                'schedule': {'deadline': '', 'buffer_episodes': None, 'work_budget_hours': None,
                             'rest_plan': '', 'note': '목표를 정하기 전에는 수치를 추정해 채우지 않는다.'},
                'panels': panels, 'reviews': []}
        init_story(ROOT, data)
        validate(data, config)
        create(manifest, data)
        print(f'생성: {args.manifest} (미검수 초안)')
        return 0
    data = read(manifest)
    if args.command == 'check':
        result = report(ROOT, data, config, args.stage)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result['ready'] else 1
    required(args.reviewer, '검수자')
    required(args.note, '검수 근거')
    prerequisites(ROOT, data, config, args.target)
    needed = checklist(config, args.target)
    if sorted(args.confirm) != sorted(needed):
        raise ValueError('각 항목을 실제 확인 후 --confirm으로 지정하세요: ' + ', '.join(needed))
    value = fingerprint(ROOT, data, config, args.target)
    data['reviews'].append({'target': args.target, 'fingerprint': value, 'checks': needed,
                            'reviewer': args.reviewer, 'note': args.note,
                            'at': datetime.now(timezone.utc).isoformat()})
    # 검수 이력 파일도 새 버전으로 남기며 원본은 변경하지 않는다.
    version = 1
    while manifest.with_name(f'{manifest.stem}.review-{version}.json').exists():
        version += 1
    out = manifest.with_name(f'{manifest.stem}.review-{version}.json')
    create(out, data)
    print(str(out.relative_to(ROOT)))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError, ImportError) as error:
        print(f'검증 실패: {error}', file=sys.stderr)
        sys.exit(1)
