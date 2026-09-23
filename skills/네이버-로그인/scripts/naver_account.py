#!/usr/bin/env python3
"""네이버 블로그별 Aside 프로필 확인·로그인 준비 도구.

블로그 ID마다 전용 Aside 브라우저 프로필(= Aside 계정 u0/u1/u2)을 두고,
발행 직전에 그 프로필의 네이버 로그인 계정이 대상 블로그와 같은지 확인한다.
로그인이 풀렸으면 macOS 키체인에 저장된 비밀번호로 재로그인하고, 저장된 것이 없으면
올바른 프로필에 로그인 창만 준비한다.

사용:
  naver_account.py list
  naver_account.py which <블로그ID>
  naver_account.py check <블로그ID>|all [--json] [--expiry]
  naver_account.py login <블로그ID> [--wait 초] [--no-auto]
  naver_account.py save-credential <블로그ID>|all  # 실제 터미널에서만. 입력은 화면에 찍히지 않는다
  naver_account.py has-credential <블로그ID>|all
  naver_account.py forget-credential <블로그ID>

check 종료 코드: 0 정상, 2 로그아웃, 3 다른 계정, 4 프로필 연결 실패, 1 사용법 오류.

비밀번호 취급 규칙
------------------
- 비밀번호는 macOS 키체인(generic password, service=naver-login)에만 둔다.
  저장소·로그·명령행 인자·대화에 남기지 않는다.
- 키체인에는 UTF-8 바이트를 hex로 인코딩해 넣는다. `security ... -w`가 비ASCII를
  hex로 돌려주기 때문에, 우리가 먼저 hex로 저장하면 왕복이 항상 일정하다.
- 자동 로그인 시 비밀번호는 argv 대신 `~/.aside/u/<N>/.naver-pw-<난수>`(0600)로 건네고
  REPL이 읽은 즉시 지운다. 실패해도 finally에서 지운다.
- `save-credential`은 TTY에서만 동작한다. 파이프·에이전트 세션에서는 입력이 그대로
  화면에 남을 수 있어 거부한다.
"""
import argparse
import binascii
import getpass
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
REGISTRY = Path(os.environ.get("NAVER_ACCOUNT_REGISTRY", SKILL_DIR / "accounts.json"))
ASIDE = os.environ.get("ASIDE_BIN", str(Path.home() / ".local/bin/aside"))
ASIDE_APP = os.environ.get("ASIDE_APP_BIN", "/Applications/Aside.app/Contents/MacOS/Aside")
LOGIN_URL = "https://nid.naver.com/nidlogin.login"
KEYCHAIN_SERVICE = os.environ.get("NAVER_KEYCHAIN_SERVICE", "naver-login")
ASIDE_HOME = Path(os.environ.get("ASIDE_HOME", Path.home() / ".aside"))
CHROME_PROFILES = Path.home() / "Library/Application Support/Aside"
SESSION_COOKIES = ("NID_AUT", "NID_SES", "nid_inf")

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


# --- 키체인 자격증명 -------------------------------------------------------

def kc_get(login_id):
    """저장된 비밀번호를 돌려준다. 없으면 None. 값을 출력하지 않는다."""
    q = subprocess.run(["security", "find-generic-password",
                        "-s", KEYCHAIN_SERVICE, "-a", login_id, "-w"],
                       capture_output=True, text=True)
    if q.returncode != 0:
        return None
    raw = q.stdout.strip()
    if not raw:
        return None
    try:
        return binascii.unhexlify(raw).decode("utf-8")
    except Exception:
        # 사람이 Keychain Access로 평문 저장한 경우
        return raw


def kc_set(login_id, password):
    hexed = binascii.hexlify(password.encode("utf-8")).decode("ascii")
    p = subprocess.run(["security", "add-generic-password", "-U",
                        "-s", KEYCHAIN_SERVICE, "-a", login_id,
                        "-l", f"{KEYCHAIN_SERVICE} ({login_id})",
                        "-j", "naver_account.py 저장. 값은 UTF-8 hex.", "-w"],
                       input=hexed + "\n" + hexed + "\n", capture_output=True, text=True)
    return p.returncode == 0, (p.stderr or "").strip()


def kc_del(login_id):
    p = subprocess.run(["security", "delete-generic-password",
                        "-s", KEYCHAIN_SERVICE, "-a", login_id],
                       capture_output=True, text=True)
    return p.returncode == 0


# --- 세션 만료 --------------------------------------------------------------

def session_expiry(profile_dir):
    """프로필 쿠키 DB에서 네이버 세션 쿠키의 만료를 읽는다. 값은 읽지 않는다."""
    db = CHROME_PROFILES / profile_dir / "Cookies"
    if not db.exists():
        return None
    tmp = Path(tempfile.mkdtemp()) / "ck.db"
    try:
        tmp.write_bytes(db.read_bytes())
        for suf in ("-wal", "-shm"):
            src = db.with_name(db.name + suf)
            if src.exists():
                tmp.with_name(tmp.name + suf).write_bytes(src.read_bytes())
        con = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        rows = con.execute(
            "select name, is_persistent, expires_utc from cookies "
            "where host_key like '%naver%' and name in (?,?,?)", SESSION_COOKIES).fetchall()
        con.close()
    except Exception as e:
        return {"error": str(e)[:120]}
    finally:
        for f in tmp.parent.glob("ck.db*"):
            f.unlink(missing_ok=True)
        tmp.parent.rmdir()
    if not rows:
        return {"cookies": 0}
    out = {"cookies": len(rows)}
    epochs = [r[2] / 1_000_000 - 11644473600 for r in rows if r[1] and r[2]]
    if epochs:
        soonest = min(epochs)
        out["expires_at"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(soonest))
        out["days_left"] = round((soonest - time.time()) / 86400, 1)
    out["persistent"] = all(r[1] for r in rows)
    return out


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


AUTOFILL_JS = r"""
const naTabs = await listBrowserTabs();
const naHit = naTabs.find(t => /nid\.naver\.com/.test(t.url));
const naPage = naHit ? await attachBrowserTab(naHit.targetId) : await openTab('__URL__');
// 폼을 반드시 새로 불러온다. 오래 열어 둔 탭을 그대로 쓰면 토큰이 만료돼
// "이미 처리되었거나 만료된 요청입니다"로 실패한다(2026-09-24 u2에서 실제 발생).
await naPage.goto('__URL__');
await naPage.waitForSelector('#id', {timeout: 20000});
await new Promise(r => setTimeout(r, 1200));
const naPw = (await fs.readFile('__PWFILE__', 'utf8')).replace(/\n$/, '');
await naPage.fill('#id', '');
await naPage.click('#id');
await naPage.keyboard.type('__ID__', {delay: 60});
const naKeep = await naPage.evaluate(() => document.querySelector('#loginStay')?.checked);
if (naKeep === false) await naPage.locator('label:has-text("로그인 상태 유지")').first().click();
await naPage.fill('#pw', naPw);
// 제출 버튼: 현재 레이아웃은 #loginBtn_row(type=button). 구버전은 #log.login.
// 패스키(#passkeyBtn_row)는 생체 인증이라 절대 누르지 않는다.
const naBtn = await naPage.evaluate(() => {
  const cand = document.querySelector('#loginBtn_row') || document.querySelector('#log\\.login')
    || [...document.querySelectorAll('button, input[type=submit]')]
         .find(b => b.id !== 'passkeyBtn_row'
                 && /^로그인$/.test((b.innerText || b.value || '').trim())
                 && b.getBoundingClientRect().height > 0);
  if (!cand) return null;
  cand.setAttribute('data-na-submit', '1');
  return cand.id || 'marked';
});
if (!naBtn) throw new Error('로그인 제출 버튼을 찾지 못했다');
await naPage.locator('[data-na-submit="1"]').first().click();
await new Promise(r => setTimeout(r, 8000));
const naOut = await naPage.evaluate(() => {
  const txt = document.body.innerText;
  // 오류 문구는 .form_message.error 에 온다. 필드 래퍼(.form_data.error)의
  // innerText 는 라벨("아이디 또는 전화번호")이라 오류로 세면 안 된다.
  const msgs = [...document.querySelectorAll('.form_message.error, .error_message, #err_common, .error_area')]
    .filter(e => e.getBoundingClientRect().height > 0 && e.innerText.trim())
    .map(e => e.innerText.trim());
  return {
    url: location.href,
    onLoginPage: !!document.querySelector('#pw'),
    err: msgs.join(' / ').slice(0, 200),
    // "일회용 번호 로그인"은 정상 로그인 화면에 항상 있는 링크다. 판정에 쓰지 않는다.
    captcha: !!document.querySelector('#captchaimg') || /자동입력 방지/.test(txt),
    needDevice: /새로운 기기|기기 등록|인증번호를 입력|2단계 인증|본인 확인이 필요/.test(txt),
  };
});
console.log('NAVER_AUTOFILL_RESULT ' + JSON.stringify(naOut));
"""


def autofill_login(blog, e, password):
    """키체인 비밀번호로 실제 로그인한다. 비밀번호는 0600 파일로만 건넨다."""
    acct = e["aside_account"]
    pwdir = ASIDE_HOME / "u" / acct.lstrip("u")
    pwdir.mkdir(parents=True, exist_ok=True)
    pwfile = pwdir / f".naver-pw-{secrets.token_hex(8)}"
    try:
        fd = os.open(pwfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(password)
        js = (AUTOFILL_JS.replace("__URL__", LOGIN_URL)
                         .replace("__ID__", e["login_id"])
                         .replace("__PWFILE__", str(pwfile)))
        _, out = repl(acct, js)
    finally:
        try:
            pwfile.unlink()
        except FileNotFoundError:
            pass
    m = re.search(r"NAVER_AUTOFILL_RESULT (\{.*\})", out)
    if not m:
        return {"ok": False, "reason": "repl_failed", "detail": out.strip()[-300:]}
    r = json.loads(m.group(1))
    if r.get("captcha"):
        return {"ok": False, "reason": "captcha", **r}
    if r.get("needDevice"):
        return {"ok": False, "reason": "device_or_2fa", **r}
    if r.get("err"):
        return {"ok": False, "reason": "login_error", **r}
    if r.get("onLoginPage"):
        # 오류 문구를 못 읽었더라도 로그인 화면에 머물러 있으면 실패다
        return {"ok": False, "reason": "still_on_login_page", **r}
    return {"ok": True, **r}


def login(blog, e, wait, auto=True):
    st = check(blog, e)
    if st["state"] == "ok":
        print(f"{blog}: 이미 로그인됨 ({e['aside_account']})")
        return 0
    # check()가 프로필 연결 실패 시 창을 이미 열었으므로 여기서는 다시 열지 않는다.
    pw = kc_get(e["login_id"]) if auto else None
    if pw:
        r = autofill_login(blog, e, pw)
        del pw
        if r["ok"]:
            for _ in range(6):
                time.sleep(5)
                if check(blog, e, relaunch=False)["state"] == "ok":
                    print(f"{blog}: 키체인 비밀번호로 자동 로그인 완료")
                    return 0
            print(f"{blog}: 비밀번호는 넣었으나 세션이 확인되지 않는다 (url {r.get('url','?')})")
        else:
            print(f"{blog}: 자동 로그인 실패 — {r['reason']}"
                  + (f" / {r.get('err')}" if r.get("err") else ""))
            if r["reason"] in ("captcha", "device_or_2fa"):
                print(f"{blog}: 이 단계는 사용자만 할 수 있다. 준비된 창에서 진행해 달라.")
        # 자동이 안 되면 아래 수동 준비 경로로 내려간다

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
    c.add_argument("--expiry", action="store_true", help="세션 쿠키 만료와 키체인 보유 여부도 출력")
    lg = sub.add_parser("login"); lg.add_argument("blog"); lg.add_argument("--wait", type=int, default=0)
    lg.add_argument("--no-auto", action="store_true", help="키체인 비밀번호를 쓰지 않고 창만 준비한다")
    sc = sub.add_parser("save-credential"); sc.add_argument("blog")
    hc = sub.add_parser("has-credential"); hc.add_argument("blog")
    fc = sub.add_parser("forget-credential"); fc.add_argument("blog")
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
        results = []
        for b in targets:
            e = entry(blogs, b)
            r = check(b, e)
            if a.expiry:
                r["session"] = session_expiry(e["profile_dir"])
                r["credential_saved"] = kc_get(e["login_id"]) is not None
            results.append(r)
        for r in results:
            if a.json:
                print(json.dumps(r, ensure_ascii=False)); continue
            line = (f"{r['blog']:14} {r['account']:3} {r['state']}"
                    + (f" (실제 {r.get('actual_blog')})" if r["state"] == "wrong_account" else ""))
            if a.expiry:
                se = r.get("session") or {}
                if se.get("expires_at"):
                    line += f"  세션 만료 {se['expires_at']} ({se['days_left']}일 남음)"
                elif se.get("cookies") == 0:
                    line += "  세션 쿠키 없음"
                line += "  비밀번호 " + ("저장됨" if r.get("credential_saved") else "없음")
            print(line)
        worst = max(EXIT.get(r["state"], 1) for r in results)
        if a.expiry:
            for r in results:
                se = r.get("session") or {}
                if r["state"] == "ok" and se.get("days_left") is not None and se["days_left"] < 7:
                    print(f"경고: {r['blog']} 세션이 {se['days_left']}일 뒤 만료된다.")
        return worst
    if a.cmd == "login":
        return login(a.blog, entry(blogs, a.blog), a.wait, auto=not a.no_auto)
    if a.cmd == "has-credential":
        targets = list(blogs) if a.blog == "all" else [a.blog]
        missing = 0
        for b in targets:
            e = entry(blogs, b)
            has = kc_get(e["login_id"]) is not None
            missing += 0 if has else 1
            print(f"{b:14} {e['login_id']:14} 비밀번호 " + ("저장됨" if has else "없음"))
        return 0 if missing == 0 else 2
    if a.cmd == "forget-credential":
        e = entry(blogs, a.blog)
        print(f"{a.blog}: 키체인 항목 " + ("삭제됨" if kc_del(e["login_id"]) else "없음(변화 없음)"))
        return 0
    if a.cmd == "save-credential":
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            print("거부: 실제 터미널에서만 실행한다. 파이프·에이전트 세션에서는 입력이 "
                  "화면과 기록에 남을 수 있다.", file=sys.stderr)
            print(f"사람이 직접 실행할 명령:\n  python3 {Path(__file__).resolve()} "
                  f"save-credential {a.blog}", file=sys.stderr)
            return 1
        targets = list(blogs) if a.blog == "all" else [a.blog]
        many = len(targets) > 1
        if many:
            print(f"블로그 {len(targets)}개의 비밀번호를 macOS 키체인에 저장한다. "
                  "건너뛰려면 빈 값으로 Enter.")
        saved, skipped, failed = [], [], []
        for b in targets:
            e = entry(blogs, b)
            if many and kc_get(e["login_id"]) is not None:
                print(f"\n[{b}] 이미 저장돼 있다. 덮어쓰려면 새 비밀번호를, 두려면 Enter.")
            else:
                print(f"\n[{b}] 로그인 ID {e['login_id']}")
            print("입력은 화면에 표시되지 않으며 저장소·로그·명령행에 남지 않는다.")
            pw1 = getpass.getpass("비밀번호: ")
            if not pw1:
                print("  건너뜀."); skipped.append(b); continue
            pw2 = getpass.getpass("한 번 더: ")
            if pw1 != pw2:
                print("  두 입력이 다르다. 저장하지 않았다.", file=sys.stderr)
                failed.append(b); del pw1, pw2; continue
            ok, err = kc_set(e["login_id"], pw1)
            del pw1, pw2
            if not ok:
                print(f"  키체인 저장 실패: {err}", file=sys.stderr); failed.append(b); continue
            print(f"  저장 완료 (service={KEYCHAIN_SERVICE}, account={e['login_id']}).")
            saved.append(b)
        print(f"\n저장 {len(saved)} / 건너뜀 {len(skipped)} / 실패 {len(failed)}")
        if failed:
            print("실패: " + ", ".join(failed), file=sys.stderr)
        print("확인: naver_account.py has-credential all")
        return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
