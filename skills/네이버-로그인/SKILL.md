---
name: 네이버-로그인
description: 네이버 블로그 여러 개를 Aside로 다룰 때 블로그 ID마다 전용 브라우저 프로필(Aside 계정 u0/u1/u2)을 골라 쓰고, 입력·임시저장·발행 직전에 로그인 계정이 대상 블로그와 맞는지 확인한다. 로그인이 풀렸으면 올바른 프로필에 로그인 창을 준비한다. 네이버 블로그 업로드·발행·수정, "네이버 로그인 스킬", "네이버 로그인", "네이버 계정 확인", "어느 프로필로", "네이버 로그인 풀림"에 사용한다.
---

# 네이버 로그인 — 블로그별 계정 라우팅

네이버는 브라우저 한 프로필에 한 계정만 로그인된다. 그래서 블로그마다 **전용 Aside 프로필**을 두고, 한 번 '로그인 상태 유지'로 로그인해 둔 세션을 계속 쓴다. 계정을 바꾸려고 로그아웃·재로그인하지 않는다.

## 대응표

정본은 [accounts.json](accounts.json) 한 벌이다. 새 블로그는 여기에만 추가한다.

| 블로그 ID | Aside 계정 | 프로필 | MCP 서버 | 용도 |
|---|---|---|---|---|
| beaconnow | u0 | Default | `aside` | Beacon Now (WordPress·GSC도 이 프로필) |
| codori_game (로그인 ID codori-game) | u1 | Profile 1 | `aside-codori-game` | 명조 관측소(게임) |
| happyturtle1004 (로그인 ID demiandew) | u2 | Profile 2 | `aside-demiandew` | 행복한 거북이 유입용 |
| gumicatholic | u4 | Profile 3 | `aside-gumicatholic` | 구미가톨릭요양병원 블로그·스마트플레이스(병원·재가센터) |
| gumicatholic-long | u5 | Profile 4 | `aside-gumicatholic-long` | 구미가톨릭요양원 블로그·스마트플레이스(요양원) |

블로그 주소(블로그 ID)와 로그인 ID가 다를 수 있다. 확인은 블로그 ID로, 로그인 창에는 `login_id`를 넣는다.

## 작업 순서

1. 대상 블로그 ID를 프로젝트 AGENTS.md나 프로필에서 확인한다. 활성 탭이나 먼저 로그인된 계정으로 추측하지 않는다.
2. 계정을 확인한다.
   ```bash
   python3 ~/.claude/skills/네이버-로그인/scripts/naver_account.py check <블로그ID>
   ```
   탭을 열지 않고 `blog.naver.com/MyBlog.naver`가 어디로 이동하는지만 본다. 종료 코드는 0 정상, 2 로그아웃, 3 다른 계정, 4 프로필 연결 실패다. 도구가 프로필 창이 닫혀 있으면 한 번 열고 다시 확인한다.
3. 정상이면 **그 블로그의 Aside 계정으로만** 조작한다.
   - CLI: `aside repl --account <uN> "$(cat script.js)"`
   - MCP: 대응표의 서버(`mcp__aside-codori-game__repl` 등)를 쓴다. 기본 `aside` 서버는 u0(beaconnow)이다.
   - 다른 블로그의 프로필에서 네이버 작업을 하지 않는다. 필요한 이미지 등은 해당 계정의 `~/.aside/u/<N>/` 아래에 복사한다(REPL 파일 루트가 계정별로 다르다).
4. 로그아웃(2)이면 로그인 창을 준비한다.
   ```bash
   python3 ~/.claude/skills/네이버-로그인/scripts/naver_account.py login <블로그ID> --wait 600
   ```
   도구는 올바른 프로필 창을 앞으로 가져오고, 아이디를 넣고, '로그인 상태 유지'를 켠다. 비밀번호가 저장돼 있지 않으면 사용자에게 **"<프로필> 창에서 비밀번호 입력 또는 QR 로그인"** 한 가지만 요청하고, 도구가 로그인 완료를 확인할 때까지 기다린다. 비밀번호·인증번호를 대화·로그·스크립트에 넣지 않는다.
5. 다른 계정(3)이면 그 전용 프로필이 오염된 것이다. `login`이 그 프로필에서만 로그아웃하고 올바른 로그인 창을 준비한다. 다른 블로그의 프로필은 건드리지 않는다.
6. 프로필 연결 실패(4)가 계속되면 `aside account list`로 계정과 프로필의 연결을 확인하고 원인을 기록한다.

## 새 블로그 추가

1. 비어 있는 다음 번호로 프로필을 만든다. `/Applications/Aside.app/Contents/MacOS/Aside --profile-directory="Profile N" https://nid.naver.com/nidlogin.login`을 실행하면, Aside 데몬이 로컬 계정 `uN`을 자동으로 만들어 그 프로필에 연결한다. `aside account list`로 확인한다.
2. accounts.json에 항목을 추가한다.
3. MCP가 필요하면 `claude mcp add -s user aside-<이름> -- ~/.local/bin/aside mcp --account uN`을 실행하고, `~/.codex/config.toml`에도 같은 내용을 추가한다.
4. `login <블로그ID> --wait 600`으로 첫 로그인을 마친 뒤 `check all`을 실행한다.

## 주의

- 한 Aside 계정에 프로필이 둘 이상 열려 있으면 CLI가 어느 쪽인지 고르지 못한다. 한 프로필은 한 계정에만 연결한다.
- 로그인 세션은 네이버 쪽 사정(비밀번호 변경, 보호조치, 장기 미사용)으로 풀릴 수 있다. 발행 흐름은 매번 `check`부터 한다.
- 새 OAuth 권한 부여, 비밀번호 발급·변경은 사용자가 한다.
