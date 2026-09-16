---
name: webtoon-production
description: 웹툰 회차 제작 파이프라인 도구. 기획·콘티 관리 파일(production.py), 콘티에서 컷 프롬프트 조립·시안(Grok)→정본(Codex) 두 단계 병렬 생성·대사 OCR 대조·690/390px 화면 렌더링·채택 기록(panel.py), 작품 저장소 연결(setup_project.py). "새 회차 만들자", "콘티 관리 파일", "컷 생성해줘", "시안 뽑아줘", "정본 생성", "대사 OCR 확인", "모바일 화면 확인", "채택해줘", "검수 기록", "납품 검사", "웹툰 프로젝트에 제작 도구 연결" 요청과, 웹툰 작품 저장소(production/project.json이 있는 곳)에서 컷을 만들거나 검수할 때 사용한다. 공개 발행은 하지 않는다.
---

# 웹툰 회차 제작 도구

한 벌의 도구를 여러 작품 저장소가 심링크로 공유한다. 작품별 설정은 각 저장소의 `production/project.json`(검수 항목·납품 규격·참조)과 `production/프롬프트-템플릿.json`(캐릭터·화풍·장소·말풍선 규칙)에만 있다.

| 파일 | 역할 |
|---|---|
| `tools/production.py` | 회차 관리 파일 init/check/review. 검수 이력과 변경 감지, 납품 파일 검사 |
| `tools/panel.py` | prompt/generate/batch/verdict/ocr/screen/adopt/status. 컷 생성 파이프라인 |
| `tools/ocr_vision.swift` | macOS Vision 한국어 OCR(첫 실행 때 `~/.cache/webtoon-ocr/`에 컴파일) |
| `tools/setup_project.py` | 작품 저장소에 도구 연결과 설정 파일 생성 |
| `README.md` | 절차·명령·판정 기준 상세. 작품 저장소의 `production/README.md`가 이 파일을 가리킨다 |
| `templates/` | 새 작품용 project.json·프롬프트 템플릿 |
| `tests/` | `python3 -m unittest discover -s tests -p 'test_p*.py' -v` |

## 정본·서사 선별 적용

작품에 `production/story-policy.json`이 있으면 기획·콘티·회차 재개 시 [공용 서사 규칙](references/story-continuity.md)과 작품의 `production/서사관리.md`를 읽는다. 신규 지정 회차의 `init`에 최소 서사 기록을 추가하며, 기존 승인·검수 파일은 소급 변경하지 않는다. 기존 AGENTS→README 경로로도 같은 규칙에 도달한다.

## 사용

1. 작품 저장소 루트(`production/project.json`이 있는 곳)나 그 아래에서 실행한다. 다른 곳에서는 `--root <루트>` 또는 `WEBTOON_ROOT`.
2. 새 회차: `python3 tools/production.py init production/N화-제목-v01.json --episode N --panels K` → brief·panels 작성(컷마다 `cast`·`prompt`·`dialogue`·`emotion`·`shot`). 표정은 `$webtoon-expression`으로 설계한다.
3. 시안: `python3 tools/panel.py batch MANIFEST --dir 원고/N화-v01 --stage draft` → 컷별 `verdict --result 통과|수정 --note`.
4. 정본: `batch --stage final` → 생성기록의 `ocr_warning` 확인 → `adopt` → `screen`으로 690·390 확인 → `production.py review`.
5. 납품: 여백 규칙으로 업로드 순서와 ZIP → `production.py check --stage delivery`. 공개 발행은 사용자 명시 요청 뒤 별도로.

이미지 생성은 `$imagegen-cli`(구독 CLI, 과금 없음)를 호출한다. 생성물은 항상 새 버전 이름이며 기존 파일을 덮어쓰지 않는다. OCR·화면 검사는 사람의 시각 검수를 대신하지 않는다.

## 새 작품 연결

```sh
python3 ~/Projects/agent-skills/skills/webtoon-production/tools/setup_project.py <작품 루트> --name "작품 이름"
```

생성된 `production/프롬프트-템플릿.json`의 `{…}` 자리(캐릭터 영문 서술·시트 경로·장소·화풍)와 `project.json`의 `references`를 채운다. 채워지지 않으면 `panel.py`가 참조 파일 없음 등으로 멈춘다.
