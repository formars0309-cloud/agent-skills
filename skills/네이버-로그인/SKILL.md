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

`aside account list`에서 u0의 `profiles`가 `Profile 0`으로 보이더라도 이를 크롬의 `--profile-directory` 값으로 해석하지 않는다. 2026-09-23 실측에서 u0가 붙는 실제 크롬 프로필 경로는 `Aside/Default`였다. 계정 슬롯 표시는 `aside repl --account u0`의 라우팅을 따르고, 디스크 프로필 경로는 `chrome://version`의 `프로필 경로`로 판정한다.

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
4. 로그아웃(2)이면 재로그인한다.
   ```bash
   python3 ~/.claude/skills/네이버-로그인/scripts/naver_account.py login <블로그ID> --wait 600
   ```
   **키체인에 비밀번호가 저장돼 있으면 도구가 직접 로그인한다**(아이디·'로그인 상태 유지'·비밀번호 입력·제출·세션 확인까지). 저장돼 있지 않거나 캡차·기기 인증·2단계 인증이 뜨면 거기서 멈추고, 올바른 프로필 창을 로그인 화면으로 준비한 뒤 사용자에게 **"<프로필> 창에서 비밀번호 입력 또는 QR 로그인"** 한 가지만 요청한다. 비밀번호·인증번호를 대화·로그·스크립트에 넣지 않는다.
   `--no-auto`를 주면 저장된 비밀번호를 쓰지 않고 창만 준비한다.
5. 다른 계정(3)이면 그 전용 프로필이 오염된 것이다. `login`이 그 프로필에서만 로그아웃하고 올바른 로그인 창을 준비한다. 다른 블로그의 프로필은 건드리지 않는다.
6. 프로필 연결 실패(4)가 계속되면 `aside account list`로 계정과 프로필의 연결을 확인하고 원인을 기록한다.

## 비밀번호 저장 — 세션이 끊겨도 AI가 복구할 수 있게

네이버 세션 쿠키는 '로그인 상태 유지'로 약 30일 지속된다. 그 뒤에는 반드시 다시 로그인해야 하므로, 비밀번호가 저장돼 있지 않으면 그때마다 작업이 멈춘다.

비밀번호는 **macOS 키체인에만** 둔다(generic password, service `naver-login`, account = `login_id`). 저장소·로그·명령행 인자·대화에는 절대 남기지 않는다.

```bash
# 사용자가 실제 터미널에서 한 번만 실행한다 (입력은 화면에 표시되지 않는다)
python3 ~/.claude/skills/네이버-로그인/scripts/naver_account.py save-credential <블로그ID>
python3 ~/.claude/skills/네이버-로그인/scripts/naver_account.py save-credential all   # 등록된 전부, 빈 값 Enter로 건너뜀

python3 ~/.claude/skills/네이버-로그인/scripts/naver_account.py has-credential all      # 보유 여부만
python3 ~/.claude/skills/네이버-로그인/scripts/naver_account.py forget-credential <블로그ID>
```

- `save-credential all`은 등록된 블로그를 차례로 물어본다. 빈 값으로 Enter하면 그 블로그는 건너뛰고, 이미 저장된 것은 덮어쓸지 물어본다. 두 입력이 다르면 그 블로그만 실패로 남기고 계속 진행한다.
- `save-credential`은 **TTY에서만** 동작한다. 파이프나 에이전트 세션에서 실행하면 입력이 그대로 기록에 남을 수 있어 거부한다. 에이전트는 이 명령을 대신 실행하지 않고 사용자에게 넘긴다.
- 키체인에는 UTF-8 바이트를 hex로 인코딩해 저장한다. `security ... -w`가 비ASCII를 hex로 돌려주기 때문에, 우리가 먼저 hex로 넣으면 한글·특수문자·16진수처럼 보이는 비밀번호까지 왕복이 항상 일정하다.
- 자동 로그인 때 비밀번호는 argv가 아니라 `~/.aside/u/<N>/.naver-pw-<난수>`(0600)로 건네고, REPL이 읽은 즉시 지운다(실패해도 `finally`에서 삭제).
- 비밀번호 저장은 로그인·재인증 용도뿐이다. 새 OAuth 권한 부여, 비밀번호 발급·변경은 그대로 사용자가 한다.

## 세션 만료 미리 보기

```bash
python3 ~/.claude/skills/네이버-로그인/scripts/naver_account.py check all --expiry
```

각 블로그의 상태와 함께 네이버 세션 쿠키(`NID_AUT`·`NID_SES`·`nid_inf`)의 만료일·남은 일수, 비밀번호 저장 여부를 출력한다. 쿠키 **값은 읽지 않는다**. 7일 미만이면 경고를 덧붙인다. 발행 일정이 촘촘한 채널은 이 값을 보고 미리 갱신한다.

## 새 블로그 추가

1. 비어 있는 다음 번호로 프로필을 만든다. `/Applications/Aside.app/Contents/MacOS/Aside --profile-directory="Profile N" https://nid.naver.com/nidlogin.login`을 실행하면, Aside 데몬이 로컬 계정 `uN`을 자동으로 만들어 그 프로필에 연결한다. `aside account list`로 확인한다.
2. accounts.json에 항목을 추가한다.
3. MCP가 필요하면 `claude mcp add -s user aside-<이름> -- ~/.local/bin/aside mcp --account uN`을 실행하고, `~/.codex/config.toml`에도 같은 내용을 추가한다.
4. `login <블로그ID> --wait 600`으로 첫 로그인을 마친 뒤 `check all`을 실행한다.

## 주의

- 한 Aside 계정에 프로필이 둘 이상 열려 있으면 CLI가 어느 쪽인지 고르지 못한다. 한 프로필은 한 계정에만 연결한다.
- 로그인 세션은 만료(약 30일)나 네이버 쪽 사정(비밀번호 변경, 보호조치, 장기 미사용)으로 풀릴 수 있다. 발행 흐름은 매번 `check`부터 한다.
- 캡차·새 기기 인증·2단계 인증은 저장된 비밀번호로도 통과할 수 없다. 자동 로그인이 `captcha`·`device_or_2fa`로 멈추면 우회하지 말고 사용자에게 그 단계만 요청한다.
- **로그인 폼은 매번 새로 불러온다.** 오래 열어 둔 nid 탭을 그대로 재사용하면 토큰이 만료돼 「이미 처리되었거나 만료된 요청입니다」로 실패한다(2026-09-24 u2 실제 발생). 비밀번호 문제로 오해하기 쉽다.
- **「일회용 번호 로그인」은 정상 로그인 화면에 항상 있는 링크다.** 2단계 인증 판정에 `일회용`·`2단계` 같은 넓은 문구를 쓰면 모든 로그인 화면이 오탐된다. 오류 문구는 `.form_message.error`에 온다(`.form_data.error`의 innerText는 필드 라벨이라 오류가 아니다).
- **쿠키 DB의 만료 시각은 디스크 반영이 늦다.** 재로그인 직후 몇 초 안에 `check --expiry`를 읽으면 옛 값이 나온다. 갱신 여부로 성공을 판정하려면 1분 남짓 기다린다. 성공 판정 자체는 `check`의 세션 상태로 한다.
- 새 OAuth 권한 부여, 비밀번호 발급·변경은 사용자가 한다.
