# Aside로 Suno 조작

먼저 로컬에서 `aside guide repl`, `aside skills list`를 실행한다. Suno용 내장 스킬이 있으면 `aside skills show <정확한 이름>`을 읽고 현재 API에 따른다. 2026-09-08 확인 당시에는 Suno용 내장 스킬이 없었다.

MCP 도구가 로드되어 있으면 Aside `repl`을 쓴다. 없을 때 CLI `aside repl --help`를 확인해 같은 코드를 실행한다. 연결 실패는 구체적인 오류를 보고한다. 비공식 Suno API·쿠키 추출·숨은 생성 엔드포인트 대신 웹 UI를 사용한다.

## 탭과 상태

```javascript
console.log(await listBrowserTabs());
```

Suno 탭이 있으면 반환된 targetId로 `attachBrowserTab(targetId)`, 없으면 `openTab('https://suno.com')`을 사용한다. 이어서 `console.log((await snapshot(page, {interactive:true})).tree)`로 읽는다.

- REPL 변수는 지속되므로 새 이름을 쓴다.
- 실제 snapshot에서 발견한 ref/역할/라벨로 조작한다. ref를 고정 스크립트에 저장하지 않는다.
- 한 동작 후 새 snapshot의 `diff`를 출력해 확인한다. 이전 ref는 재사용하지 않는다.
- 읽기 확대는 interactive snapshot → 전체 snapshot → 화면이 전환 중일 때만 짧은 대기 → screenshot 순이다. snapshot을 잘라 출력하지 않는다.
- 페이지에서 발견한 Create·Custom·Sounds·Instrumental·Download 메뉴를 따라간다. UI 이름이나 내부 URL을 추측하지 않는다.

## 다운로드

현재 Aside 가이드가 지원하는 브라우저 download 이벤트를 우선 사용한다. 버튼 ref와 출력 경로는 현재 작업에서 확인한 것으로 바꾼다.

```javascript
const sunoDownloadPending = page.waitForEvent('download');
await page.locator(verifiedDownloadRef).click();
const sunoDownload = await sunoDownloadPending;
const sunoDownloadPath = await sunoDownload.path();
console.log({filename: sunoDownload.suggestedFilename(), path: sunoDownloadPath,
  size: (await fs.stat(sunoDownloadPath)).size});
console.log((await snapshot(page)).diff);
```

필요한 목적지 사본은 `download.saveAs()`로 저장하고 다시 크기를 확인한다. REPL의 파일 접근 범위와 로컬 셸 파일 접근 범위가 같다고 가정하지 않는다. CLI 일회성 REPL은 세션 종료 전에 파일을 검증한다. 현재 페이지에서 확인한 same-origin 또는 신뢰할 수 있는 직접 다운로드 GET/HEAD에만 `fetch`를 사용한다. 쿠키를 다른 출처로 전달하지 않는다.

## 설치 시 확인 범위

2026-09-08 Aside MCP 연결과 Suno 공개 첫 화면을 확인했다. Log in 버튼이 보이는 로그아웃 상태였으므로 구독 플랜·로그인 후 메뉴·생성·청취·다운로드는 실계정 검증하지 않았다. 다음 실제 제작 작업에서 로그인 후 확인하며, 이 문서를 성공 실행 기록으로 취급하지 않는다.
