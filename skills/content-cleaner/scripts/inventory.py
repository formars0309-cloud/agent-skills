#!/usr/bin/env python3
"""콘텐츠 파일 메타데이터와 중복 후보를 조사한다. 삭제 기능은 없다."""
import argparse
import hashlib
import json
import os
import re
import stat
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

EXCLUDED = {'.git', '.hg', '.svn', 'node_modules', '.venv', 'venv',
            '__pycache__', '.ssh', '.aws', '.Trash'}
SENSITIVE = re.compile(r'(^\.env($|\.)|credential|secret|token|password|환자|개인정보)', re.I)
HINT = re.compile(r'(tmp|temp|cache|preview|render|draft|backup|시안|초안|임시|미리보기)', re.I)


def fingerprint(s):
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def digest(path, expected):
    # 교체된 파일·심링크를 해시 결과에 섞지 않는다.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or fingerprint(before) != expected:
            raise ValueError('조사 이후 변경된 파일')
        h = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
        if fingerprint(os.fstat(stream.fileno())) != expected:
            raise ValueError('해시 계산 중 변경된 파일')
        if fingerprint(os.lstat(path)) != expected:
            raise ValueError('해시 계산 중 경로가 교체됨')
        return h.hexdigest()


def scan(roots, hash_duplicates=False):
    files, skipped, errors = [], [], []
    seen = set()
    for root in roots:
        def error(exc):
            errors.append({'path': exc.filename, 'error': str(exc)})
        for directory, dirs, names in os.walk(root, followlinks=False, onerror=error):
            for name in list(dirs):
                p = Path(directory) / name
                if name in EXCLUDED or SENSITIVE.search(name) or p.is_symlink():
                    dirs.remove(name)
                    skipped.append({'path': str(p), 'reason': '보호 디렉터리 또는 심볼릭 링크'})
            for name in names:
                p = Path(directory) / name
                if str(p) in seen:
                    continue
                seen.add(str(p))
                try:
                    s = p.lstat()
                    if not stat.S_ISREG(s.st_mode) or SENSITIVE.search(name) or p.suffix.lower() in {'.pem', '.key', '.p12', '.pfx'}:
                        skipped.append({'path': str(p), 'reason': '보호 파일 또는 비일반 파일'})
                        continue
                    files.append({'path': str(p), 'root': str(root), 'bytes': s.st_size,
                                  'allocated_bytes': s.st_blocks * 512,
                                  'fingerprint': fingerprint(s), 'links': s.st_nlink,
                                  'name_hint_only': bool(HINT.search(str(p.relative_to(root))))})
                except OSError as exc:
                    error(exc)
    duplicates = []
    if hash_duplicates:
        sizes = defaultdict(list)
        for row in files:
            sizes[row['bytes']].append(row)
        for size, rows in sizes.items():
            if size == 0 or len(rows) < 2:
                continue
            hashes = defaultdict(list)
            for row in rows:
                try:
                    value = digest(row['path'], row['fingerprint'])
                    row['sha256'] = value
                    hashes[value].append(row['path'])
                except (OSError, ValueError) as exc:
                    errors.append({'path': row['path'], 'error': str(exc)})
            duplicates.extend({'sha256': h, 'bytes_each': size, 'paths': paths}
                              for h, paths in hashes.items() if len(paths) > 1)
    return {'created_at': datetime.now(timezone.utc).isoformat(),
            'read_only': True, 'roots': [str(r) for r in roots],
            'files': sorted(files, key=lambda r: r['bytes'], reverse=True),
            'duplicate_candidates': duplicates, 'skipped': skipped, 'errors': errors,
            'note': '후보는 삭제 허가가 아니다. 보호 이름 탐지는 완전한 비밀 정보 검사가 아니다.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', action='append', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--hash-duplicates', action='store_true')
    args = parser.parse_args()
    roots = []
    for raw in args.root:
        p = Path(os.path.abspath(Path(raw).expanduser()))
        if any(part.is_symlink() for part in [p, *p.parents]) or not p.is_dir():
            parser.error(f'실재하는 비심링크 디렉터리가 필요함: {p}')
        if not any(p == r or r in p.parents for r in roots):
            roots = [r for r in roots if p not in r.parents] + [p]
    output = Path(args.output).expanduser().absolute()
    resolved_output = output.resolve()
    if any(r == resolved_output or r in resolved_output.parents for r in roots):
        parser.error('보고서는 조사 대상 밖에 저장해야 함')
    if output.exists():
        parser.error('기존 보고서를 덮어쓰지 않음')
    report = scan(roots, args.hash_duplicates)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'files': len(report['files']), 'duplicate_groups': len(report['duplicate_candidates']),
                      'errors': len(report['errors']), 'report': str(output)}, ensure_ascii=False))
    return 1 if report['errors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
