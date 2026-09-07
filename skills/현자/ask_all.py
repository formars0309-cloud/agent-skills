#!/usr/bin/env python
"""현자 — 여러 AI CLI에 같은 질문을 동시에 던지고 답을 한 화면에 모은다.

사용:
  현자 "질문"                        # 기본: claude codex grok gemini (askall 도 같은 명령)
  현자 -a claude,grok "질문"         # 일부만
  현자 -t 600 "질문"                 # 타임아웃(초, 기본 300)
  현자 --no-open "질문"              # 브라우저 안 열고 터미널 출력만
  echo "여러 줄 질문" | 현자          # 질문을 stdin으로

작업 폴더: ~/orca/projects/현자 가 있으면 거기서 실행한다. 네 CLI가 그 폴더의 AGENTS.md(공통 지침)를
읽고, 답은 answers/<시각>.md·.html 로 남아 자동 커밋된다. 폴더가 없으면 빈 임시 폴더에서 돌고 ~/askall 에 저장한다.
표준 라이브러리만 쓴다.
"""
import argparse
import datetime
import html
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

WORKSPACE = pathlib.Path.home() / 'orca' / 'projects' / '현자'


def cmd_for(agent, q, tmpdir):
    # codex는 진행 로그를 stdout에 찍으므로 최종 답만 -o 파일로 받는다
    out = os.path.join(tmpdir, 'codex-last.md')
    return {
        'claude': ['claude', '-p', q],
        'codex': ['codex', 'exec', '--skip-git-repo-check', '-s', 'read-only', '-o', out, q],
        'grok': ['grok', '-p', q],
        'gemini': ['gemini', '--skip-trust', '-p', q],  # 신뢰 목록에 없는 폴더도 허용
    }[agent], out


def ask(agent, q, timeout, cwd, tmpdir):
    cmd, outfile = cmd_for(agent, q, tmpdir)
    exe = shutil.which(cmd[0])  # 윈도우 .cmd 셔틀도 찾는다
    if not exe:
        return agent, '(CLI 없음: %s)' % cmd[0], 0.0
    cmd[0] = exe
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
                           timeout=timeout, cwd=cwd, stdin=subprocess.DEVNULL)
        text = ''
        if agent == 'codex' and os.path.exists(outfile):
            text = pathlib.Path(outfile).read_text(encoding='utf-8', errors='replace').strip()
        text = text or (p.stdout or '').strip() or (p.stderr or '').strip() or '(빈 응답, 종료코드 %s)' % p.returncode
    except subprocess.TimeoutExpired:
        text = '(타임아웃 %d초)' % timeout
    return agent, text, time.time() - t0


def main():
    ap = argparse.ArgumentParser(description='여러 AI CLI에 동시에 질문')
    ap.add_argument('question', nargs='?', help='질문. 없으면 stdin에서 읽는다')
    ap.add_argument('-a', '--agents', default='claude,codex,grok,gemini')
    ap.add_argument('-t', '--timeout', type=int, default=300)
    ap.add_argument('--no-open', action='store_true')
    args = ap.parse_args()
    q = (args.question or sys.stdin.read()).strip()
    if not q:
        ap.error('질문이 비었습니다')
    agents = [a.strip() for a in args.agents.split(',') if a.strip()]

    tmp = tempfile.mkdtemp(prefix='hyunja-')
    if WORKSPACE.is_dir():
        cwd, outdir = WORKSPACE, WORKSPACE / 'answers'
    else:
        cwd, outdir = pathlib.Path(tmp), pathlib.Path.home() / 'askall'
    print('질문:', q, file=sys.stderr)
    print('실행 중: %s (최대 %d초, 폴더 %s)' % (', '.join(agents), args.timeout, cwd), file=sys.stderr)
    with ThreadPoolExecutor(len(agents)) as ex:
        results = list(ex.map(lambda a: ask(a, q, args.timeout, str(cwd), tmp), agents))
    shutil.rmtree(tmp, ignore_errors=True)

    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    outdir.mkdir(parents=True, exist_ok=True)
    md = ['# %s' % q, '', '_%s_' % stamp, '']
    for agent, text, sec in results:
        md += ['## %s (%.0f초)' % (agent, sec), '', text, '']
    (outdir / (stamp + '.md')).write_text('\n'.join(md), encoding='utf-8')

    cols = ''.join(
        '<section><h2>%s <small>%.0f초</small></h2><pre>%s</pre></section>' % (agent, sec, html.escape(text))
        for agent, text, sec in results)
    page = ('<!doctype html><meta charset="utf-8"><title>현자 %s</title>'
            '<style>body{margin:0;font-family:system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;'
            'background:#f6f6f4;color:#222}h1{font-size:18px;margin:0;padding:14px 18px;background:#fff;'
            'border-bottom:1px solid #ddd;position:sticky;top:0}main{display:flex;gap:12px;padding:12px;'
            'align-items:flex-start}section{flex:1 1 0;min-width:0;background:#fff;border:1px solid #ddd;'
            'border-radius:8px}h2{font-size:15px;margin:0;padding:10px 14px;border-bottom:1px solid #eee}'
            'small{color:#888;font-weight:normal}pre{white-space:pre-wrap;word-break:break-word;margin:0;'
            'padding:14px;font-family:inherit;font-size:14px;line-height:1.6}</style>'
            '<h1>%s</h1><main>%s</main>') % (stamp, html.escape(q), cols)
    htmlpath = outdir / (stamp + '.html')
    htmlpath.write_text(page, encoding='utf-8')

    if (cwd / '.git').exists():  # 기록을 곧바로 커밋해 남긴다
        subprocess.run(['git', '-C', str(cwd), 'add', 'answers'], capture_output=True)
        subprocess.run(['git', '-C', str(cwd), 'commit', '-q', '-m', '질문: ' + q[:60]], capture_output=True)

    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    print('\n'.join(md))
    print('저장:', htmlpath, file=sys.stderr)
    if not args.no_open:
        try:
            os.startfile(str(htmlpath))  # 윈도우 기본 브라우저
        except AttributeError:
            subprocess.Popen(['xdg-open', str(htmlpath)])


if __name__ == '__main__':
    main()
