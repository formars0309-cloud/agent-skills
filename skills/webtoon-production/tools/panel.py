"""회차 관리 파일과 프롬프트 템플릿으로 컷 프롬프트를 조립하고, 생성·채택 결과를 기록한다.

production.py는 검수 이력만 다룬다. 이 도구는 그 앞단인 컷 생성을 맡는다.
  prompt    관리 파일의 컷 정보 + 템플릿 → 프롬프트 파일과 참조 목록
  generate  프롬프트를 조립해 imagegen-cli를 호출하고 새 버전 파일로 저장·기록
  verdict   시안 버전에 통과/수정 판정을 기록(두 단계 생성의 관문)
  batch     여러 컷을 병렬로 생성. --stage draft(시안 백엔드) / final(정본 백엔드, 통과 시안이 있는 컷만)
  ocr       납품 JPG의 글자를 읽어(macOS Vision) 콘티 대사와 대조. generate 뒤 자동 실행
  screen    채택본(없으면 최신 버전)을 690·390px 화면으로 렌더링해 컷별 스크린샷 저장
  adopt     생성 버전 하나를 납품 슬롯(업로드/NN.jpg)으로 채택하고 관리 파일에 기록
  status    컷별 생성 버전·시안 판정·채택·검수 상태 표
생성 결과는 항상 새 버전 이름으로 만들며 기존 파일을 덮어쓰지 않는다. 공개 발행은 하지 않는다.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent  # 심링크를 따라 스킬의 tools 폴더
ROOT = None
IMAGEGEN = Path.home() / '.claude/skills/imagegen-cli/scripts/imagegen_cli.py'
VERSION_RE = re.compile(r'^(\d{2})(?:-v(\d+))?\.(png|jpg)$')
OCR_SOURCE = TOOLS / 'ocr_vision.swift'
OCR_BINARY = Path.home() / '.cache/webtoon-ocr/ocr_vision'


def read_json(file):
    return json.loads(Path(file).read_text(encoding='utf-8'))


def write_json(file, value):
    """같은 디렉터리의 임시 파일에 쓴 뒤 교체한다."""
    file = Path(file)
    tmp = file.with_name(file.name + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, file)


def sha256(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def rel(root, file):
    return str(Path(file).resolve().relative_to(root.resolve()))


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def spelled(text):
    return ', '.join('space' if ch == ' ' else ch for ch in text)


def panel_of(data, panel_id):
    panel = next((p for p in data['panels'] if p['id'] == panel_id), None)
    if panel is None:
        raise ValueError(f'없는 컷: {panel_id}')
    return panel


def setting_of(panel, template):
    name = panel.get('setting')
    if not name:
        match = re.match(r'\[([^\]]+)\]', panel['scene'])
        name = match.group(1) if match else ''
    if name not in template['settings']:
        raise ValueError(f"{panel['id']}: 장소 '{name}'의 영문 설명을 템플릿 settings에 추가하세요.")
    return template['settings'][name]


def line_of(entry, panel, template):
    """'발화자: 본문' 한 줄을 (본문, 말풍선 지시)로 바꾼다."""
    if ':' not in entry:
        raise ValueError(f"{panel['id']}: 대사는 '발화자: 본문' 형식이어야 합니다: {entry}")
    speaker, text = (s.strip() for s in entry.split(':', 1))
    if not text:
        raise ValueError(f"{panel['id']}: 본문이 비었습니다: {entry}")
    chars = template['characters']
    if speaker in template['bubbles'] and speaker not in ('생각', '대사'):
        how = template['bubbles'][speaker]
    elif speaker in template['speakers']:
        how = template['speakers'][speaker]
    elif speaker in chars:
        if speaker not in panel['cast']:
            raise ValueError(f"{panel['id']}: 발화자 {speaker}가 cast에 없습니다.")
        kind = '생각' if text.startswith('(') and text.endswith(')') else '대사'
        how = template['bubbles'][kind].format(who=chars[speaker]['name_en'])
    else:
        raise ValueError(f"{panel['id']}: 알 수 없는 발화자 '{speaker}'. 템플릿 speakers에 추가하세요.")
    return f'- "{text}" (characters: {spelled(text)}) {how}.'


def references(root, data, panel, template, dirpath, stage='final'):
    """첨부 순서대로 (경로, 설명) 목록. 캐릭터 시트 → 화풍 기준 컷 → 컷별 추가 참조.
    시안 단계에서는 아직 채택되지 않은 참조 컷 대신 그 컷의 최신 생성 버전을 쓴다."""
    refs = []
    for name in panel['cast']:
        if name not in template['characters']:
            raise ValueError(f"{panel['id']}: 템플릿에 없는 인물 {name}")
        ch = template['characters'][name]
        refs.append((root / ch['sheet'], ch['sheet_note']))
    style = template.get('style_reference')
    if style and not panel.get('no_style_reference'):
        refs.append((root / style['path'], style['note']))
    for extra in panel.get('extra_refs', []):
        if 'panel' in extra:
            other = panel_of(data, extra['panel'])
            if other.get('source'):
                file = root / other['source']
            elif stage == 'draft' and versions(dirpath, extra['panel']):
                found = versions(dirpath, extra['panel'])
                file = found[max(found)]
            else:
                raise ValueError(f"{panel['id']}: 참조할 {extra['panel']}컷이 아직 채택되지 않았습니다.")
        else:
            file = root / extra['path']
        refs.append((file, extra['note']))
    for file, _ in refs:
        if not file.is_file():
            raise ValueError(f"{panel['id']}: 참조 파일 없음 {file}")
    return refs


def assemble(root, data, panel_id, template, dirpath, stage='final'):
    panel = panel_of(data, panel_id)
    for key in ('cast', 'prompt'):
        if not panel.get(key):
            raise ValueError(f'{panel_id}: {key}를 채우세요.')
    refs = references(root, data, panel, template, dirpath, stage)
    lines = [template['style']]
    lines += [f'Image {i}: {note}' for i, (_, note) in enumerate(refs, 1)]
    lines.append('')
    lines.append(template['request_prefix'].format(id=panel_id) + panel['prompt'].strip())
    lines.append('Characters: ' + ' '.join(template['characters'][c]['description'] for c in panel['cast']))
    lines.append('Scene: ' + setting_of(panel, template))
    if panel['dialogue']:
        lines.append(template['lettering'])
        lines.append('Text (verbatim):')
        lines += [line_of(entry, panel, template) for entry in panel['dialogue']]
    else:
        lines.append(template['no_text'])
    lines.append(template['constraints'])
    lines.append(template['avoid'])
    return '\n'.join(lines) + '\n', [file for file, _ in refs]


def versions(dirpath, panel_id):
    """원본 폴더의 NN.png / NN-vK.png 를 {K: 경로}로. 접미사 없는 파일은 v1."""
    found = {}
    folder = dirpath / '원본'
    if folder.is_dir():
        for file in folder.iterdir():
            match = VERSION_RE.match(file.name)
            if match and match.group(1) == panel_id:
                found[int(match.group(2) or 1)] = file
    return found


def next_version(dirpath, panel_id):
    return max(versions(dirpath, panel_id), default=0) + 1


def write_prompt(dirpath, name, prompt, refs):
    folder = dirpath / '프롬프트'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f'{name}.txt').write_text(prompt, encoding='utf-8')
    (folder / f'{name}.refs').write_text(''.join(str(r) + '\n' for r in refs), encoding='utf-8')
    return folder / f'{name}.txt'


def generate_one(root, data, template, dirpath, panel_id, backend, timeout=None, dry_run=False,
                 edit=None, instruction=None, stage=None):
    """한 컷을 새 버전으로 생성하고 기록 한 줄을 돌려준다. 병렬 호출해도 안전하다."""
    stage = stage or ('draft' if backend == template['generation'].get('draft_backend') else 'final')
    version = next_version(dirpath, panel_id)
    name = f'{panel_id}-v{version}'
    gen = template['generation']
    if edit:
        if not instruction:
            raise ValueError('--edit에는 --instruction이 필요합니다.')
        prompt = '\n'.join([template['edit_prefix'], 'Instruction: ' + instruction.strip(),
                            template['constraints'], template['avoid']]) + '\n'
        refs = []
    else:
        prompt, refs = assemble(root, data, panel_id, template, dirpath, stage)
    prompt_file = write_prompt(dirpath, name, prompt, refs)
    for folder in ('원본', '업로드', '검수'):
        (dirpath / folder).mkdir(parents=True, exist_ok=True)
    out = dirpath / '원본' / f'{name}.png'
    jpg = dirpath / '업로드' / f'{name}.jpg'
    log = dirpath / '검수' / f'{name}-{backend}.log'
    cmd = [sys.executable, str(IMAGEGEN), '--backend', backend, '--prompt-file', str(prompt_file),
           '--out', str(out), '--jpg-width', str(gen['jpg_width']), '--jpg-out', str(jpg),
           '--timeout', str(timeout or gen['timeout'])]
    if edit:
        cmd += ['--edit', str(root / edit)]
    for ref in refs:
        cmd += ['--ref', str(ref)]
    cmd += ['--size', gen['size']] if backend == 'codex' else ['--aspect', gen['aspect']]
    record = {'panel': panel_id, 'version': version, 'backend': backend, 'stage': stage,
              'mode': 'edit' if edit else 'generate',
              'prompt': rel(root, prompt_file), 'prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
              'refs': [rel(root, r) for r in refs], 'edit_source': edit or None, 'at': now()}
    if dry_run:
        record['command'] = cmd
        return record
    with log.open('w', encoding='utf-8') as stream:
        result = subprocess.run(cmd, cwd=root, stdout=stream, stderr=subprocess.STDOUT, text=True)
    record['exit'] = result.returncode
    record['log'] = rel(root, log)
    last = [l for l in log.read_text(encoding='utf-8').splitlines() if l.startswith('{')]
    if result.returncode == 0 and last:
        info = json.loads(last[-1])
        record.update({'source': rel(root, out), 'source_sha256': info.get('sha256'),
                       'attachments': len(info.get('attachments', [])), 'seconds': info.get('seconds'),
                       'output': rel(root, jpg), 'output_sha256': (info.get('jpg') or {}).get('sha256'),
                       'width': (info.get('jpg') or {}).get('pixelWidth')})
        if record['attachments'] != len(refs):
            record['warning'] = f'첨부 {record["attachments"]}장 ≠ 참조 {len(refs)}장'
        try:
            report = ocr_check(root, panel_of(data, panel_id), jpg, dirpath / '검수' / f'{name}-ocr.json')
            record['ocr'] = report['summary']
            if report['summary']['missing'] or report['summary']['extra']:
                record['ocr_warning'] = f"누락 {len(report['summary']['missing'])}, 예상 밖 {len(report['summary']['extra'])}"
        except ValueError as error:
            record['ocr'] = {'error': str(error)}
    append_record(dirpath, record)
    return record


def append_record(dirpath, record):
    with (dirpath / '생성기록.jsonl').open('a', encoding='utf-8') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(record, ensure_ascii=False) + '\n')
        stream.flush()
        fcntl.flock(stream, fcntl.LOCK_UN)


def generate(root, data, template, args):
    record = generate_one(root, data, template, root / args.dir, args.panel, args.backend, args.timeout,
                          args.dry_run, args.edit, args.instruction)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return record.get('exit', 0)


def latest_verdict(panel):
    drafts = panel.get('drafts') or []
    return drafts[-1] if drafts else None


def verdict(root, data, args, manifest):
    dirpath = root / args.dir
    panel = panel_of(data, args.panel)
    found = versions(dirpath, args.panel)
    if args.version not in found:
        raise ValueError(f'{args.panel}: 없는 버전 v{args.version}. 있는 버전: {sorted(found)}')
    if not args.note.strip():
        raise ValueError('판정 근거를 --note에 적으세요.')
    panel.setdefault('drafts', []).append({'version': args.version, 'result': args.result,
                                           'note': args.note.strip(), 'at': now()})
    write_json(manifest, data)
    print(json.dumps(panel['drafts'][-1], ensure_ascii=False))
    return 0


def select_batch(data, stage, wanted, force=False):
    """단계별 대상 컷과 건너뛴 이유. draft: 통과 시안이나 채택본이 없는 컷. final: 최신 시안이 통과인 컷."""
    chosen, skipped = [], []
    for panel in data['panels']:
        if wanted and panel['id'] not in wanted:
            continue
        last = latest_verdict(panel)
        if panel.get('adopted') and not force:
            skipped.append((panel['id'], f"채택본 v{panel['adopted']['version']} 있음"))
        elif stage == 'draft':
            if last and last['result'] == '통과' and not force:
                skipped.append((panel['id'], f"시안 v{last['version']} 통과됨"))
            else:
                chosen.append(panel['id'])
        else:
            if force or (last and last['result'] == '통과'):
                chosen.append(panel['id'])
            else:
                skipped.append((panel['id'], '통과한 시안 없음' if not last else f"최신 시안 v{last['version']} {last['result']}"))
    return chosen, skipped


def batch(root, data, template, args):
    gen = template['generation']
    backend = args.backend or (gen['draft_backend'] if args.stage == 'draft' else gen['final_backend'])
    jobs = args.jobs or gen.get('jobs', {}).get(backend, 1)
    chosen, skipped = select_batch(data, args.stage, set(args.panels or []), args.force)
    for panel_id, why in skipped:
        print(f'{panel_id} 건너뜀: {why}')
    if not chosen:
        print('생성할 컷이 없습니다.')
        return 0
    print(f'{args.stage} 단계 {backend} 동시 {jobs}개: {" ".join(chosen)}')
    dirpath = root / args.dir
    started = datetime.now()
    def work(panel_id):
        try:
            return generate_one(root, data, template, dirpath, panel_id, backend, args.timeout, args.dry_run, stage=args.stage)
        except ValueError as error:
            return {'panel': panel_id, 'exit': 1, 'error': str(error)}
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        records = list(pool.map(work, chosen))
    failed = 0
    for record in records:
        failed += 1 if record.get('exit', 0) else 0
        summary = record.get('error') or record.get('warning') or f"v{record['version']} {record.get('seconds', '-')}초 첨부 {record.get('attachments', '-')}장"
        if record.get('ocr_warning'):
            summary += ' OCR ' + record['ocr_warning']
        print(f"{record['panel']}: exit={record.get('exit', 0)} {summary}")
    print(f'벽시계 {int((datetime.now() - started).total_seconds())}초, 실패 {failed}')
    return 1 if failed else 0


# ---------- OCR 대사 대조 ----------

def ocr_binary():
    """Vision OCR 실행 파일. 소스보다 오래됐거나 없으면 컴파일한다. swiftc가 없으면 None."""
    if not OCR_SOURCE.is_file() or not shutil.which('swiftc'):
        return None
    if not OCR_BINARY.is_file() or OCR_BINARY.stat().st_mtime < OCR_SOURCE.stat().st_mtime:
        OCR_BINARY.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(['swiftc', '-O', '-o', str(OCR_BINARY), str(OCR_SOURCE)], capture_output=True, text=True)
        if result.returncode:
            return None
    return OCR_BINARY


def ocr_lines(file):
    binary = ocr_binary()
    if binary is None:
        raise ValueError('OCR 실행 파일을 만들 수 없습니다(swiftc 필요).')
    result = subprocess.run([str(binary), str(file)], capture_output=True, text=True)
    if result.returncode or not result.stdout.strip():
        raise ValueError('OCR 실행 실패: ' + result.stderr.strip()[:200])
    info = json.loads(result.stdout.strip().splitlines()[-1])
    if 'error' in info:
        raise ValueError('OCR: ' + info['error'])
    return info['lines']


def normalize(text):
    """공백·문장부호·기호를 빼고 글자·숫자만 남긴다. OCR이 …을 •로 읽는 차이를 흡수한다."""
    return ''.join(ch for ch in unicodedata.normalize('NFC', text)
                   if unicodedata.category(ch)[0] in ('L', 'N'))


def expected_texts(panel):
    return [entry.split(':', 1)[1].strip() for entry in panel['dialogue'] if ':' in entry]


def compare_text(expected, fragments):
    """fragments: OCR 줄 목록(text·box). 예상 대사별 found/partial/missing과 예상 밖 조각을 돌려준다."""
    frags = [dict(f, norm=normalize(f['text'])) for f in fragments]
    frags = [f for f in frags if f['norm']]
    used = set()
    results = []
    for text in expected:
        target = normalize(text)
        mine = [i for i, f in enumerate(frags) if i not in used and f['norm'] and f['norm'] in target]
        mine.sort(key=lambda i: (round(frags[i]['box'][1], 2), frags[i]['box'][0]))
        joined = ''.join(frags[i]['norm'] for i in mine)
        if joined == target:
            state = 'found'
        elif target in joined or (mine and all(frags[i]['norm'] in target for i in mine) and len(joined) >= len(target) * 0.6):
            state = 'partial'
        else:
            state = 'missing'
        if state != 'missing':
            used.update(mine)
        results.append({'text': text, 'state': state, 'read': ''.join(frags[i]['text'] + ' ' for i in mine).strip()})
    extra = [f['text'] for i, f in enumerate(frags) if i not in used and len(f['norm']) >= 2]
    summary = {'found': sum(r['state'] == 'found' for r in results),
               'partial': sum(r['state'] == 'partial' for r in results),
               'missing': [r['text'] for r in results if r['state'] == 'missing'],
               'extra': extra}
    return results, summary


def ocr_check(root, panel, jpg, out_file=None):
    lines = ocr_lines(jpg)
    results, summary = compare_text(expected_texts(panel), lines)
    report = {'file': rel(root, jpg), 'panel': panel['id'], 'at': now(), 'lines': lines,
              'results': results, 'summary': summary}
    if out_file:
        write_json(out_file, report)
    return report


def ocr(root, data, args):
    dirpath = root / args.dir
    panel = panel_of(data, args.panel)
    if args.version:
        jpg = dirpath / '업로드' / f'{args.panel}-v{args.version}.jpg'
    elif panel.get('output'):
        jpg = root / panel['output']
    else:
        raise ValueError('--version 또는 채택본이 필요합니다.')
    if not jpg.is_file():
        raise ValueError(f'파일 없음: {jpg}')
    report = ocr_check(root, panel, jpg, dirpath / '검수' / (jpg.stem + '-ocr.json'))
    for r in report['results']:
        print(f"{r['state']:<8} {r['text']}  ← {r['read']}")
    if report['summary']['extra']:
        print('예상 밖 글자:', ' | '.join(report['summary']['extra']))
    return 0 if not report['summary']['missing'] else 1


# ---------- 화면 렌더링 ----------

READ_HTML = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><style>body{{margin:0;background:#fff}}main{{display:flex;flex-direction:column;align-items:center}}
main img{{display:block;width:100%;max-width:690px;height:auto;margin:0}}</style><main>{images}</main>"""


def screen_targets(root, data, dirpath, wanted):
    """컷별 (id, JPG 경로). 채택본이 있으면 그것, 없으면 최신 생성 버전의 JPG."""
    targets = []
    for panel in data['panels']:
        if wanted and panel['id'] not in wanted:
            continue
        if panel.get('output') and (root / panel['output']).is_file():
            targets.append((panel['id'], root / panel['output'], '채택본'))
            continue
        found = versions(dirpath, panel['id'])
        if found:
            jpg = dirpath / '업로드' / (found[max(found)].stem + '.jpg')
            if jpg.is_file():
                targets.append((panel['id'], jpg, f'v{max(found)}'))
    return targets


def chromium_path():
    """playwright가 기대하는 빌드가 없을 때 설치돼 있는 가장 최신 Chromium 실행 파일."""
    if os.environ.get('WEBTOON_CHROMIUM'):
        return os.environ['WEBTOON_CHROMIUM']
    cache = Path.home() / 'Library/Caches/ms-playwright'
    candidates = sorted(cache.glob('chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell')) + \
        sorted(cache.glob('chromium-*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
    return str(candidates[-1]) if candidates else None


def launch_browser(p):
    try:
        return p.chromium.launch(headless=True)
    except Exception as error:  # 버전 불일치
        path = chromium_path()
        if not path:
            raise ValueError(f'Chromium을 찾을 수 없습니다: {error}') from None
        return p.chromium.launch(headless=True, executable_path=path)


def screen(root, data, args):
    from playwright.sync_api import sync_playwright
    dirpath = root / args.dir
    out = dirpath / '화면검수'
    out.mkdir(parents=True, exist_ok=True)
    targets = screen_targets(root, data, dirpath, set(args.panels or []))
    if not targets:
        raise ValueError('렌더링할 JPG가 없습니다.')
    images = ''.join(f'<img src="{os.path.relpath(jpg, out)}" alt="{pid}" data-panel="{pid}">' for pid, jpg, _ in targets)
    html = out / '읽기.html'
    html.write_text(READ_HTML.format(title=f"{data['episode']}화 화면검수", images=images), encoding='utf-8')
    report = {'at': now(), 'targets': [{'panel': pid, 'file': rel(root, jpg), 'which': which} for pid, jpg, which in targets], 'widths': {}}
    with sync_playwright() as p:
        browser = launch_browser(p)
        for width in args.widths:
            page = browser.new_page(viewport={'width': width, 'height': 844}, device_scale_factor=1)
            page.goto(html.as_uri())
            page.wait_for_load_state('load')
            shots = []
            for i, (pid, _, _) in enumerate(targets):
                item = page.locator('main img').nth(i)
                item.scroll_into_view_if_needed()
                item.evaluate('(im) => im.decode()')
                box = item.bounding_box()
                file = out / f'{width}-{pid}.png'
                item.screenshot(path=str(file))
                shots.append({'panel': pid, 'width': round(box['width']), 'height': round(box['height']), 'shot': rel(root, file)})
            stats = page.evaluate('() => ({count: document.images.length, loaded: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth})')
            stats['overflow'] = stats['scrollWidth'] > stats['viewport']
            stats['shots'] = shots
            report['widths'][str(width)] = stats
            page.close()
        browser.close()
    write_json(out / '화면검증.json', report)
    for width, stats in report['widths'].items():
        print(f"{width}px: {stats['loaded']}/{stats['count']} 로딩, 가로 넘침 {'있음' if stats['overflow'] else '없음'}, 컷 폭 {sorted({s['width'] for s in stats['shots']})}")
    print(f"읽기: {rel(root, html)}  스크린샷: {rel(root, out)}/")
    return 0


def adopt(root, data, args, manifest):
    dirpath = root / args.dir
    panel = panel_of(data, args.panel)
    found = versions(dirpath, args.panel)
    if args.version not in found:
        raise ValueError(f'{args.panel}: 없는 버전 v{args.version}. 있는 버전: {sorted(found)}')
    source = found[args.version]
    chosen = dirpath / '업로드' / (source.stem + '.jpg')
    if not chosen.is_file():
        raise ValueError(f'납품용 JPG가 없습니다: {chosen}')
    slot = dirpath / '업로드' / f'{args.panel}.jpg'
    preserved = None
    if slot.is_file() and sha256(slot) != sha256(chosen):
        known = {sha256(f) for f in (dirpath / '업로드').glob(f'{args.panel}-v*.jpg')}
        if sha256(slot) not in known:
            k = max(found, default=0) + 1
            preserved = slot.with_name(f'{args.panel}-v{k}.jpg')
            shutil.move(slot, preserved)
        else:
            slot.unlink()
    if not slot.is_file():
        shutil.copyfile(chosen, slot)
    panel['source'] = rel(root, source)
    panel['output'] = rel(root, slot)
    panel['adopted'] = {'version': args.version, 'output_sha256': sha256(slot), 'at': now()}
    write_json(manifest, data)
    print(json.dumps({'panel': args.panel, 'source': panel['source'], 'output': panel['output'],
                      'preserved': rel(root, preserved) if preserved else None}, ensure_ascii=False))
    return 0


def status(root, data, args):
    import importlib.util
    spec = importlib.util.spec_from_file_location('production', TOOLS / 'production.py')
    production = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(production)
    config = read_json(ROOT / 'production/project.json')
    dirpath = root / args.dir
    rows = []
    for panel in data['panels']:
        found = versions(dirpath, panel['id'])
        adopted = panel.get('adopted', {}).get('version')
        valid = production.receipt_valid(root, data, config, panel['id']) if panel.get('output') else False
        last = latest_verdict(panel)
        rows.append((panel['id'], ','.join(f'v{k}' for k in sorted(found)) or '-',
                     f"v{last['version']} {last['result']}" if last else '-',
                     f'v{adopted}' if adopted else '-', '통과' if valid else '미검수'))
    print('컷  생성버전        시안판정   채택  검수')
    for row in rows:
        print(f'{row[0]:<3} {row[1]:<15} {row[2]:<10} {row[3]:<5} {row[4]}')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--template', default='production/프롬프트-템플릿.json')
    parser.add_argument('--root', help='작품 저장소 루트(기본: 현재 위치에서 탐색)')
    sub = parser.add_subparsers(dest='command', required=True)
    for name, help_text in (('prompt', '프롬프트·참조 목록 파일 생성'), ('generate', '컷 생성(새 버전)'),
                            ('verdict', '시안 판정 기록'), ('batch', '여러 컷 병렬 생성'),
                            ('ocr', '대사 OCR 대조'), ('screen', '690·390px 화면 렌더링'),
                            ('adopt', '버전 채택과 관리 파일 기록'), ('status', '컷별 상태')):
        s = sub.add_parser(name, help=help_text)
        s.add_argument('manifest')
        s.add_argument('--dir', required=True, help='회차 작업 폴더, 예: 원고/3화-v02')
        if name not in ('status', 'batch', 'screen'):
            s.add_argument('--panel', required=(name != 'prompt'), help='컷 ID, 예: 01')
        if name == 'ocr':
            s.add_argument('--version', type=int, help='비우면 채택본')
        if name == 'screen':
            s.add_argument('--panels', nargs='*')
            s.add_argument('--widths', nargs='*', type=int, default=[690, 390])
        if name == 'prompt':
            s.add_argument('--all', action='store_true')
        if name == 'generate':
            s.add_argument('--backend', choices=['codex', 'grok'], default='codex')
            s.add_argument('--edit', help='국소 편집 대상(저장소 상대 경로)')
            s.add_argument('--instruction', help='--edit 지시문')
            s.add_argument('--timeout', type=int)
            s.add_argument('--dry-run', action='store_true', help='명령만 출력')
        if name == 'adopt':
            s.add_argument('--version', type=int, required=True)
        if name == 'verdict':
            s.add_argument('--version', type=int, required=True)
            s.add_argument('--result', choices=['통과', '수정'], required=True)
            s.add_argument('--note', required=True, help='콘티 대비 확인한 내용')
        if name == 'batch':
            s.add_argument('--stage', choices=['draft', 'final'], required=True)
            s.add_argument('--panels', nargs='*', help='비우면 단계 규칙으로 자동 선택')
            s.add_argument('--backend', choices=['codex', 'grok'], help='기본은 템플릿의 단계별 백엔드')
            s.add_argument('--jobs', type=int, help='동시 실행 수(기본은 템플릿 generation.jobs)')
            s.add_argument('--force', action='store_true', help='시안 판정·채택 여부를 무시하고 지정 컷 생성')
            s.add_argument('--timeout', type=int)
            s.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    global ROOT
    spec = importlib.util.spec_from_file_location('production', TOOLS / 'production.py')
    production = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(production)
    ROOT = production.find_root(args.root)
    template = read_json(ROOT / args.template)
    manifest = ROOT / args.manifest
    data = read_json(manifest)
    if data.get('project') != template['project']:
        raise ValueError('관리 파일과 템플릿의 작품이 다릅니다.')
    if args.command == 'prompt':
        ids = [p['id'] for p in data['panels']] if args.all else [args.panel]
        if not args.all and not args.panel:
            raise ValueError('--panel 또는 --all')
        failed = 0
        for panel_id in ids:
            try:
                prompt, refs = assemble(ROOT, data, panel_id, template, ROOT / args.dir)
            except ValueError as error:
                failed += 1
                print(f'{panel_id} 보류: {error}')
                continue
            file = write_prompt(ROOT / args.dir, panel_id, prompt, refs)
            print(f'{rel(ROOT, file)} 참조 {len(refs)}장')
        return 1 if failed else 0
    if args.command == 'generate':
        return generate(ROOT, data, template, args)
    if args.command == 'verdict':
        return verdict(ROOT, data, args, manifest)
    if args.command == 'batch':
        return batch(ROOT, data, template, args)
    if args.command == 'ocr':
        return ocr(ROOT, data, args)
    if args.command == 'screen':
        return screen(ROOT, data, args)
    if args.command == 'adopt':
        return adopt(ROOT, data, args, manifest)
    return status(ROOT, data, args)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f'실패: {error}', file=sys.stderr)
        sys.exit(1)
