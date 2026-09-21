#!/usr/bin/env python3
"""네이버 블로그별 Aside 프로필 확인·로그인 준비 도구.

블로그 ID마다 전용 Aside 브라우저 프로필(= Aside 계정 u0/u1/u2)을 두고,
발행 직전에 그 프로필의 네이버 로그인 계정이 대상 블로그와 같은지 확인한다.
비밀번호는 다루지 않는다. 로그인이 풀렸으면 올바른 프로필에 로그인 창을 준비만 한다.

사용:
  naver_account.py list
  naver_account.py which <블로그ID>
  naver_account.py check <블로그ID>|all [--json]
  naver_account.py login <블로그ID> [--wait 초]

check 종료 코드: 0 정상, 2 로그아웃, 3 다른 계정, 4 프로필 연결 실패, 1 사용법 오류.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
REGISTRY = Path(os.environ.get("NAVER_ACCOUNT_REGISTRY", SKILL_DIR / "accounts.json"))
ASIDE = os.environ.get("ASIDE_BIN", str(Path.home() / ".local/bin/aside"))
ASIDE_APP = os.environ.get("ASIDE_APP_BIN", "/Applications/Aside.app/Contents/MacOS/Aside")
LOGIN_URL = "https://nid.naver.com/nidlogin.login"

EXIT = {"ok": 0, "logged_out": 2, "wrong_account": 3, "profile_unreachable": 4}

WHO_JS = r"""
const naR = await fetch('https://blog.naver.com/MyBlog.naver', {redirect: 'follow'});
console.log('NAVER_ACCOUNT_RESULT ' + JSON.stringify({status: naR.status, url: naR.url}));
"""


def load():
    return json.loads(REGISTRY.read_text(encoding="utf-8"))["blogs"]


def entry(blogs, blog):
    if blog not in blogs:
        sys.exit(f"알 수 없는 블로그 ID: {blog} (등록: {', '.join(blogs)})")
    return blogs[blog]


def repl(account, code, timeout=150):
    p = subprocess.run([ASIDE, "repl", "--account", account, code],
                       capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def launch_profile(profile_dir, url=LOGIN_URL):
    """해당 프로필의 일반 창을 연다. 없던 프로필이면 새로 만들어진다."""
    subprocess.Popen([ASIDE_APP, f"--profile-directory={profile_dir}", url],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(6)


def check(blog, e, relaunch=True):
    code, out = repl(e["aside_account"], WHO_JS)
    m = re.search(r"NAVER_ACCOUNT_RESULT (\{.*\})", out)
    if not m:
        if relaunch:
            # 프로필 창이 닫혀 브리지가 끊긴 경우: 창을 열고 한 번 더 확인한다.
            launch_profile(e["profile_dir"], "https://blog.naver.com/MyBlog.naver")
            return check(blog, e, relaunch=False)
        tail = out.strip().splitlines()[-3:]
        return {"blog": blog, "account": e["aside_account"], "state": "profile_unreachable",
                "detail": " / ".join(tail)}
    url = json.loads(m.group(1))["url"]
    if "nid.naver.com" in url:
        state, actual = "logged_out", None
    else:
        mm = re.match(r"https?://(?:m\.)?blog\.naver\.com/([A-Za-z0-9_-]+)", url)
        actual = mm.group(1) if mm else url
        state = "ok" if actual.lower() == blog.lower() else "wrong_account"
    return {"blog": blog, "account": e["aside_account"], "state": state, "actual_blog": actual}


LOGIN_JS = r"""
const naTabs = await listBrowserTabs();
const naHit = naTabs.find(t => /nid\.naver\.com\/nidlogin/.test(t.url));
const naPage = naHit ? await attachBrowserTab(naHit.targetId) : await openTab('__URL__');
await naPage.bringToFront().catch(() => {});
await naPage.waitForSelector('#id', {timeout: 15000});
const naCur = await naPage.evaluate(() => document.querySelector('#id').value);
if (naCur !== '__ID__') {
  await naPage.fill('#id', '');
  await naPage.click('#id');
  await naPage.keyboard.type('__ID__', {delay: 90});
}
const naKeep = await naPage.evaluate(() => document.querySelector('#loginStay')?.checked);
if (naKeep === false) await naPage.locator('label:has-text("로그인 상태 유지")').first().click();
await naPage.click('#pw');
console.log('NAVER_LOGIN_READY ' + JSON.stringify(await naPage.evaluate(() => ({
  id: document.querySelector('#id').value,
  keep: document.querySelector('#loginStay')?.checked ?? null,
}))));
"""


def login(blog, e, wait):
    st = check(blog, e)
    if st["state"] == "ok":
        print(f"{blog}: 이미 로그인됨 ({e['aside_account']})")
        return 0
    # check()가 프로필 연결 실패 시 창을 이미 열었으므로 여기서는 다시 열지 않는다.
    js = LOGIN_JS.replace("__URL__", LOGIN_URL).replace("__ID__", e["login_id"])
    if st["state"] == "wrong_account":
        # 전용 프로필에 다른 계정이 들어가 있으면 그 프로필에서만 로그아웃한다.
        # fetch 로그아웃은 세션을 끊지 못한다(2026-09-21 확인). 네이버 첫 화면의 로그아웃 버튼을 누른다.
        js = ("const naOut = await openTab('https://www.naver.com/');\n"
              "await naOut.click('#account button:has-text(\"로그아웃\")');\n"
              "await sleep(3000);\nawait closeTab(naOut);\n" + js)
    _, out = repl(e["aside_account"], js)
    m = re.search(r"NAVER_LOGIN_READY (\{.*\})", out)
    if not m:
        print(out.strip()[-800:])
        return 4
    print(f"{blog}: {e['profile_dir']}({e['aside_account']}) 창에 로그인 화면을 준비했다. "
          f"아이디 {e['login_id']} 입력·로그인 상태 유지 켬. 비밀번호 입력 또는 QR 로그인만 남았다.")
    if wait <= 0:
        return 2
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(10)
        st = check(blog, e, relaunch=False)
        if st["state"] == "ok":
            print(f"{blog}: 로그인 확인 완료")
            return 0
    print(f"{blog}: {wait}초 안에 로그인이 확인되지 않음 (상태 {st['state']})")
    return EXIT.get(st["state"], 2)


def main():
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    w = sub.add_parser("which"); w.add_argument("blog")
    c = sub.add_parser("check"); c.add_argument("blog"); c.add_argument("--json", action="store_true")
    lg = sub.add_parser("login"); lg.add_argument("blog"); lg.add_argument("--wait", type=int, default=0)
    a = ap.parse_args()
    blogs = load()

    if a.cmd == "list":
        for b, e in blogs.items():
            print(f"{b:14} {e['aside_account']:3} {e['profile_dir']:10} MCP={e['mcp_server']:18} {e['name']}")
        return 0
    if a.cmd == "which":
        e = entry(blogs, a.blog)
        print(json.dumps({"blog": a.blog, **{k: e[k] for k in ("aside_account", "profile_dir", "mcp_server")}},
                         ensure_ascii=False))
        return 0
    if a.cmd == "check":
        targets = list(blogs) if a.blog == "all" else [a.blog]
        results = [check(b, entry(blogs, b)) for b in targets]
        for r in results:
            print(json.dumps(r, ensure_ascii=False) if a.json else
                  f"{r['blog']:14} {r['account']:3} {r['state']}"
                  + (f" (실제 {r.get('actual_blog')})" if r["state"] == "wrong_account" else ""))
        return max(EXIT.get(r["state"], 1) for r in results)
    if a.cmd == "login":
        return login(a.blog, entry(blogs, a.blog), a.wait)


if __name__ == "__main__":
    sys.exit(main())
