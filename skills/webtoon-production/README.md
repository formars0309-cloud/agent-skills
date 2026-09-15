# 회차 제작 관리

작가의 작업 방식을 이 저장소의 실행 가능한 제작 절차로 옮겼다. 원고 생성·공개 발행 도구가 아니라 **기획 → 콘티 → 컷별 제작·검수 → 납품 검증**의 진행 상태와 변경 영향을 확인하는 CLI다. Python 3.10 이상을 사용한다.

## 근거와 적용 범위

- 하일권의 장면에서 시작하는 구상·회차 말미의 궁금증을 `premise`, `turn`, `ending`으로 옮겼다. [에듀코카](https://edu.kocca.kr/edu/bbs/B0000023/view.do?menuNo=500206&nttId=74993&pageIndex=6)
- 윤태호의 취재·대사 집중, 배경 병행 제작을 `research_note`, 컷별 `owner`와 원본/납품 경로로 옮겼다. [인터뷰](https://slownews.kr/16882)
- 이종범이 언급한 신체·심리적 부담을 일정·작업 예산·휴식 계획 기록으로 반영했다. 이는 자동 건강 판정이나 작가의 고정 시간표를 재현한 것이 아니다. [인터뷰](https://www.kocis.go.kr/koreanet/view.do?langCode=lang001&searchType=menu0026&seq=1045688)

이하 단계와 검수 항목은 위 사례를 참고한 프로젝트 설계다. 실제 작가들이 이 JSON이나 고정 공정 순서를 사용한다는 뜻은 아니다. 글 콘티와 그림 콘티는 필요에 따라 오가며, 배경·채색은 담당자를 적어 병행할 수 있다.

## 실행

모든 명령은 작품 저장소 루트에서 실행한다. 다른 디렉터리에서 스크립트를 실행해도 파일 경로는 이 저장소 루트 기준이다.

```sh
python3 -m pip install -r tools/requirements-production.txt
python3 tools/production.py init production/새회차-v01.json --episode 3 --panels 16
python3 tools/production.py check production/새회차-v01.json --stage brief
```

여짝마 기존 콘티를 관리 파일로 옮길 때는 `init`에 `--from-storyboard 기획/2화-콘티-v03.json`을 더하고 `--episode 2`로 지정한다. 기존 콘티와 원고는 수정하지 않으며 검수 상태는 모두 미완료로 시작한다. AI 작품의 별도 `1화 기획` 저장소를 연결할 때는 그 저장소에 이 도구를 별도로 도입하거나 필요한 자료를 작품 정본으로 반영한다. 다른 저장소의 파일을 암묵적으로 수정하지 않는다.

JSON의 기획, 취재 메모, 참조 목록, 컷별 장면·감정·구도·대사·담당자를 채운다. 무대사는 `dialogue: []`로 쓴다. `source`에는 보존된 생성 원본, `output`에는 대사·말풍선까지 들어간 `01.jpg` 같은 최종 컷을 지정한다. 원본은 덮어쓰지 않는다.

`references`에는 해당 회차에서 실제 사용한 캐릭터 시트·설정·레터링 기준을 모두 넣는다. 파일명이 프롬프트에 들어 있다는 것만으로 실제 이미지 참조 첨부를 대신할 수 없다.

검수 항목은 `project.json`에 있다. 실제로 항목을 확인한 뒤 기록한다. 예를 들어 기획 검수는 다음과 같다.

```sh
python3 tools/production.py review production/새회차-v01.json --target brief \
  --reviewer '검수 담당자' --note '장면 목적·회차 끝·취재 구분·일정 검토 내용' \
  --confirm 장면의목적 --confirm 전환과회차끝 --confirm 취재와허구구분 --confirm 일정과휴식
```

명령은 **새 검수 버전의 경로**를 출력한다. 다음 명령과 편집에는 그 경로를 사용한다. `--target storyboard`로 콘티를 검수한 다음 `--target 01`처럼 개별 컷을 검수한다. 해당 대상의 모든 `--confirm` 항목을 지정해야 한다. 이 기록은 담당자의 확인 진술이며 컴퓨터의 시각 검수나 사용자의 공개 승인이 아니다.

```sh
python3 tools/production.py check production/새회차-v01.review-1.json --stage production
python3 tools/production.py check production/새회차-v01.review-1.json --stage delivery
python3 -m unittest discover -s tests -p 'test_production.py' -v
```

`pending`에 남은 대상이 작업 목록이다. 기획·콘티 검수가 끝나면 컷별 작업을 병행할 수 있다. 각 담당자는 별도 버전의 산출물을 만들고 조율자가 관리 파일을 갱신한다. 공유 JSON을 동시에 편집하지 않는다. CLI가 작업자를 실행하지는 않는다.

## 변경·마감·납품

컷 내용/원본/납품본의 SHA-256이 달라지면 그 컷의 기존 검수는 무효다. 장면·대사·감정·순서가 바뀌면 콘티도 다시 검수한다. 공통 기획·참조 파일·검수 규칙이 바뀌면 전체 검수가 무효다. 변경하지 않은 컷의 이미지 해시는 유지된다. 이력은 버전 파일에 보존한다.

`deadline`, `buffer_episodes`, `work_budget_hours`, `rest_plan`은 실제 계획을 기록하는 필드다. 일정 수치는 검수 해시와 별개이며, 계획 변경만으로 그림 검수를 무효화하지 않는다. 자동 일정 최적화나 비축 원고 존재 검증은 하지 않는다. 비축 목표를 모든 작가에게 같은 숫자로 강제하지 않는다.

납품 검사는 전체 검수 후 실제 JPEG 디코딩·RGB·가로 690px·파일당 5MB 미만·합계 50MB 이하·번호/중복을 확인한다. 손·표정·한 컷 구성·모바일 가독성은 사람이 최종 이미지에서 확인해야 한다. `ready: true`는 제작 검수 기록과 파일 검사의 충족이며 공개 발행 승인이 아니다. 네트워크 요청·자동 결제·업로드는 없다.

기존 2화 콘티의 `panel_specs`를 가져올 수 있다. 캐릭터 디자인기준·레터링규칙과 실제 시트 이미지를 `references`에 추가한다. 기존 1화의 공개 정본을 새 도구로 재생성하지 않는다.

## 컷 프롬프트 조립·생성·채택 — `tools/panel.py`

`production.py`가 검수 이력을 다룬다면 `panel.py`는 그 앞단인 컷 생성을 맡는다. 공통 블록(화풍·캐릭터 서술·시트 경로·장소 설명·말풍선 규칙·금지 사항)은 `production/프롬프트-템플릿.json`에 한 번만 두고, 컷 고유 정보는 회차 관리 파일의 `panels`에 둔다. 손으로 쓴 프롬프트 20개에 같은 문단을 복사하던 방식을 대체한다.

컷에 필요한 추가 필드:

- `cast`: 등장 인물 이름 목록(`["마왕", "세렌"]`). 인물 시트가 이 순서로 첨부되고 대사 발화자 검증에 쓰인다.
- `prompt`: 이 컷만의 영문 연출·표정·구도 지시. 캐릭터 고정 서술·장소·레터링·제약은 넣지 않는다.
- `setting`(선택): 장소 이름. 없으면 `scene`의 `[장소]` 태그를 쓴다. 템플릿 `settings`에 영문 설명이 있어야 한다.
- `extra_refs`(선택): `{"path": ..., "note": ...}` 또는 `{"panel": "04", "note": ...}`. 후자는 그 컷의 채택된 원본을 첨부하므로 먼저 채택되어 있어야 한다.
- `dialogue`의 각 줄은 `발화자: 본문`. 인물 이름이면 말풍선, `( )`로 감싸면 생각 풍선, `자막`·`효과음`과 템플릿 `speakers`(마왕 목소리·신탁·쪽지)는 각자의 조판 지시로 바뀐다. 글자 하나하나를 나열한 철자 목록도 자동으로 붙는다.

```sh
python3 tools/panel.py prompt   production/3화-먹빛기도-v03.json --dir 원고/3화-v02 --all      # 프롬프트·참조 목록만
python3 tools/panel.py generate production/3화-먹빛기도-v03.json --dir 원고/3화-v02 --panel 01 --backend grok   # 시안
python3 tools/panel.py generate production/3화-먹빛기도-v03.json --dir 원고/3화-v02 --panel 01               # 정본(codex)
python3 tools/panel.py generate ... --panel 01 --edit 원고/3화-v02/원본/01-v2.png --instruction "only fix the left hand"
python3 tools/panel.py adopt    production/3화-먹빛기도-v03.json --dir 원고/3화-v02 --panel 01 --version 2
python3 tools/panel.py status   production/3화-먹빛기도-v03.json --dir 원고/3화-v02
```

- `generate`는 항상 새 버전(`원본/01-v2.png`, `업로드/01-v2.jpg`, `프롬프트/01-v2.txt`·`.refs`, `검수/01-v2-codex.log`)을 만들고 `생성기록.jsonl`에 백엔드·참조·SHA-256·소요 시간을 추가한다. 첨부 수가 참조 수와 다르면 `warning`을 남긴다. 기존 파일은 덮어쓰지 않는다.
- `adopt`는 고른 버전을 납품 슬롯 `업로드/NN.jpg`로 복사하고 관리 파일의 `source`·`output`·`adopted`를 채운다. 슬롯에 버전 이름 없는 파일이 있으면 새 버전 이름으로 옮겨 보존한다. 채택 뒤 `production.py review --target NN`으로 검수한다.
- 시각 검수는 여전히 사람이 한다. `--dry-run`은 명령만 출력한다. 검증: `python3 -m unittest discover -s tests -p 'test_p*.py' -v`.

### 두 단계 생성 — 시안(Grok) → 정본(Codex)

Codex 정본은 컷당 2~5분, Grok 시안은 1분 안팎이다. 구도·인물 방향·소품 배치가 콘티와 맞는지는 시안으로 먼저 확인하고, 통과한 컷만 정본을 뽑는다. 시안 판정은 관리 파일 `drafts`에 남는다.

```sh
python3 tools/panel.py batch   MANIFEST --dir DIR --stage draft                 # 통과 시안·채택본이 없는 컷 전부, Grok 병렬
python3 tools/panel.py verdict MANIFEST --dir DIR --panel 01 --version 1 --result 통과 --note "구도·방향·소품 콘티와 일치"
python3 tools/panel.py verdict MANIFEST --dir DIR --panel 02 --version 1 --result 수정 --note "세렌 몸이 신전 쪽으로 돌아서지 않음"
#   → 수정이면 관리 파일 prompt를 고친 뒤 batch --stage draft --panels 02
python3 tools/panel.py batch   MANIFEST --dir DIR --stage final                 # 최신 시안이 통과인 컷만, Codex 병렬
python3 tools/panel.py adopt   MANIFEST --dir DIR --panel 01 --version 2
```

- `--stage draft`는 `extra_refs`의 `panel` 참조가 아직 채택되지 않았으면 그 컷의 최신 생성 버전을 대신 첨부한다. `--stage final`은 채택본만 쓴다.
- 판정 기준은 시안 단계에서 볼 수 있는 것에 한정한다: 한 컷 한 순간, 등장 인물과 수, 구도·시점, 인물의 몸·시선 방향, 소품·배경 요소, 대사 텍스트 정확성. 표정 미묘함·손 세부·레터링 동일성은 정본에서 본다.
- `--panels`로 대상을 좁히고, `--force`는 판정·채택을 무시하고 지정 컷을 만든다. `--jobs`는 동시 실행 수이며 기본은 템플릿 `generation.jobs`의 백엔드별 값이다. 동시 실행해도 버전 번호는 컷마다 매기므로 충돌하지 않는다.

### 기계 검수 앞단 — 대사 OCR 대조와 화면 렌더링

사람이 보기 전에 기계가 잡을 수 있는 것을 먼저 거른다. 판정을 대신하지는 않는다.

```sh
python3 tools/panel.py ocr    MANIFEST --dir DIR --panel 01 --version 2   # 비우면 채택본
python3 tools/panel.py screen MANIFEST --dir DIR [--panels 01 02] [--widths 690 390]
```

- `ocr`은 macOS Vision(`tools/ocr_vision.swift`, 첫 실행 때 `~/.cache/webtoon-ocr/`에 컴파일)으로 납품 JPG의 글자를 읽어 콘티 `dialogue`와 대조한다. 공백·문장부호는 무시하고 글자만 비교하므로 `…`을 `•`로 읽는 차이는 통과한다. 결과는 대사별 `found`·`partial`·`missing`과 예상 밖 글자(영문·환각 텍스트)이며 `검수/NN-vK-ocr.json`에 남는다. `generate`·`batch`는 생성 직후 자동으로 실행해 `생성기록.jsonl`의 `ocr`에 요약을 넣고 누락·예상 밖 글자가 있으면 `ocr_warning`을 표시한다. OCR이 놓쳐도 실제로는 맞을 수 있으니 `missing`은 사람이 확인한다.
- `screen`은 채택본(없으면 최신 생성 버전)을 `화면검수/읽기.html`에 세로로 놓고 690px·390px 뷰포트로 렌더링해 컷별 스크린샷 `690-NN.png`·`390-NN.png`과 `화면검증.json`(로딩 수·가로 넘침·컷 폭)을 만든다. 2화의 `기획/2화-화면검증-v05.py`를 대체한다. playwright가 기대하는 Chromium 빌드가 없으면 설치된 최신 빌드를 자동으로 쓰며 `WEBTOON_CHROMIUM`으로 지정할 수 있다. 여백 규칙 적용 전의 컷 단위 확인이며 업로드 순서·여백은 납품 단계에서 따로 만든다.
