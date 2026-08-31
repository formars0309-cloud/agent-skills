"""기준본 ↔ 파생본 사실 무결성 검사

07-final-package.md(의료 기준본)와 파생본(08-naver-blog.md 등)을 대조해
수치가 누락·변경·신규 도입됐는지, 결론 한정어가 빠졌는지 검사한다.

자동 검수(beacon.ps1 validate)는 구조·인용·표현만 본다. 이 스크립트는 그 사각지대를 덮는다.
2026-07-31 postpartum-hemorrhage에서 실제로 놓쳤던 유형:
  - WOMAN 결과변수 확대: "출혈로 인한 사망" → "사망"  (결론 범위 확대)
  - 경고 역치 상향: "1개를 넘겨 적심" → "1개를 흠뻑 넘겨 적실 때"
둘 다 validate는 오류 0으로 통과시켰다.

선택적으로 outputs/<slug>/fact-guard.json을 두면 주제별 감시 문구를 지정할 수 있다:
  {
    "required": ["출혈로 인한 사망", "3시간"],      // 파생본에 반드시 있어야 함
    "forbidden": ["흠뻑", "완치"],                  // 있으면 안 됨
    "ignoreNumbers": ["2025", "2022"]              // 대조에서 제외할 숫자(연도 등)
  }

사용법:
  python check.py --base 원본.md --derived 윤문본.md
  python check.py --slug <slug>            # Beacon Now 계열 구조
  python scripts/check_fact_integrity.py --slug <slug> --derived 08-naver-blog.md
종료 코드: 0 통과 / 1 문제 발견
"""

import sys

# Windows 콘솔 기본 인코딩(cp949)에서 한글과 기호가 깨지거나 예외로 죽는다.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 숫자 + 단위. 의료 콘텐츠에서 바뀌면 안 되는 값들.
UNIT = r"(?:mL|ml|L|mg|g|kg|시간|분|초|일|주|개월|년|회|명|건|개|%|배|도|℃)"
NUM_UNIT = re.compile(rf"(\d[\d,]*(?:\.\d+)?)\s*({UNIT})")
# 범위 표기 (7~14일, 2-4시간)
RANGE = re.compile(rf"(\d+)\s*[~\-–]\s*(\d+)\s*({UNIT})")

# 결론 범위를 좁히는 한정어가 빠지면 결론이 넓어진다.
# CRITICAL: 결과변수·역치를 직접 좁히는 말. 빠지면 [문제]다.
QUALIFIERS_CRITICAL = ["출혈로 인한", "중증", "이내", "이상", "이하", "미만", "초과", "넘겨"]
# SOFT: 채널 축약으로 빠질 수 있다. [확인]으로만 표시한다.
QUALIFIERS_SOFT = ["일부", "대부분", "경우에 따라", "질식분만", "제왕절개", "출혈"]

# 연도로 보이는 숫자는 수치 대조에서 뺀다(1900~2099 + '년')
YEARISH = re.compile(r"^(19|20)\d{2}년$")

# 경고 역치를 흐리거나 올리는 표현
THRESHOLD_RISK = ["흠뻑", "심하게", "아주 많이", "완전히", "푹", "매우"]


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s)


def numbers(text: str, ignore) -> dict:
    """숫자+단위를 정규화해 카운트한다."""
    out = {}
    for a, b, u in RANGE.findall(text):
        if a in ignore or b in ignore:
            continue
        k = f"{a}~{b}{u}"
        out[k] = out.get(k, 0) + 1
    # 범위로 잡힌 부분은 제외하고 단독 숫자 수집
    masked = RANGE.sub(" ", text)
    for n, u in NUM_UNIT.findall(masked):
        n = n.replace(",", "")
        if n in ignore:
            continue
        k = f"{n}{u}"
        out[k] = out.get(k, 0) + 1
    return out


def main():
    ap = argparse.ArgumentParser(
        description="기준본과 파생본을 대조해 수치 누락·변경과 한정어 소실을 찾는다.")
    ap.add_argument("--base", help="기준본 파일 경로")
    ap.add_argument("--derived", help="파생본 파일 경로")
    ap.add_argument("--guard", help="감시 문구 JSON 경로 (선택)")
    # 하위 호환: Beacon Now 계열의 outputs/<slug>/ 구조
    ap.add_argument("--slug", help="outputs/<slug>/ 구조에서 찾을 때 사용")
    args = ap.parse_args()

    if args.slug:
        d = ROOT / "outputs" / args.slug
        base_p = d / "07-final-package.md"
        der_p = d / (args.derived or "08-naver-blog.md")
        gp = Path(args.guard) if args.guard else d / "fact-guard.json"
    else:
        if not (args.base and args.derived):
            ap.error("--base 와 --derived 를 함께 지정하거나 --slug 를 사용하세요")
        base_p, der_p = Path(args.base), Path(args.derived)
        d = base_p.parent
        gp = Path(args.guard) if args.guard else d / "fact-guard.json"

    for p in (base_p, der_p):
        if not p.exists():
            print(f"파일 없음: {p}")
            sys.exit(2)

    guard = {}
    if gp.exists():
        guard = json.loads(read(gp))
    ignore = set(guard.get("ignoreNumbers", []))

    base, der = strip_html(read(base_p)), strip_html(read(der_p))

    # 파생본은 표·요약을 카드 이미지로 대체한다. 카드 문구도 파생 콘텐츠이므로 함께 검사한다.
    vp = d / "naver-visuals.json"
    if vp.exists():
        v = json.loads(read(vp))
        buf = []

        def collect(node):
            if isinstance(node, str):
                buf.append(node)
            elif isinstance(node, list):
                for x in node:
                    collect(x)
            elif isinstance(node, dict):
                for k, x in node.items():
                    if k in ("file", "alt", "insertAfter", "slug", "output_dir",
                             "source_package", "source_url", "rules", "generator_note"):
                        continue
                    collect(x)

        # 표는 1장이면 `table`(객체), 2장이면 `tables`(배열)다 (naver-format-v2 §6).
        # `tables`를 빠뜨리면 표 2장 패키지에서 표 안의 수치가 전부 "누락"으로 잡힌다.
        for key in ("thumbnail", "summary", "one_liner", "table", "tables"):
            if key in v:
                collect(v[key])
        der += " " + " ".join(buf)
        print(f"카드 문구 {len(buf)}개를 파생본에 합쳐 검사한다 ({vp.name})")
    bn, dn = numbers(base, ignore), numbers(der, ignore)

    problems, notes = [], []

    # 1. 기준본에 있는데 파생본에 없는 수치
    for k in sorted(set(bn) - set(dn)):
        notes.append(f"수치 누락  {k}  (기준본 {bn[k]}회 → 파생본 0회)")

    # 2. 파생본에만 있는 수치 = 없던 값이 생김. 위험. (연도는 제외)
    for k in sorted(set(dn) - set(bn)):
        if YEARISH.match(k):
            continue
        problems.append(f"신규 수치  {k}  파생본에만 존재 — 기준본에 없는 값이다")

    # 3. 결론 한정어 누락
    for q in QUALIFIERS_CRITICAL:
        b, dd = base.count(q), der.count(q)
        if b > 0 and dd == 0:
            problems.append(f"한정어 소실  '{q}'  (기준본 {b}회 → 파생본 0회) — 결론 범위가 넓어졌는지 확인")
    for q in QUALIFIERS_SOFT:
        b, dd = base.count(q), der.count(q)
        if b > 0 and dd == 0:
            notes.append(f"한정어 소실  '{q}'  (기준본 {b}회 → 파생본 0회)")

    # 4. 역치를 흐리는 표현
    for w in THRESHOLD_RISK:
        if w in der and w not in base:
            problems.append(f"역치 표현  '{w}'  파생본에만 있음 — 경고 기준이 바뀌었는지 확인")

    # 5. fact-guard 지정 문구
    for r in guard.get("required", []):
        if r not in der:
            problems.append(f"필수 문구 누락  '{r}'")
    for f in guard.get("forbidden", []):
        if f in der:
            problems.append(f"금지 문구 발견  '{f}'")

    print(f"기준본: {base_p.name}   파생본: {der_p.name}")
    print(f"수치 토큰: 기준본 {len(bn)}종 / 파생본 {len(dn)}종")
    if gp.exists():
        print(f"fact-guard.json 적용: required {len(guard.get('required', []))} / "
              f"forbidden {len(guard.get('forbidden', []))}")
    print()

    if problems:
        print(f"[문제 {len(problems)}건]")
        for p in problems:
            print(f"  ✗ {p}")
        print()
    if notes:
        print(f"[확인 {len(notes)}건] — 일반 독자용 축약이면 정상일 수 있다")
        for n in notes:
            print(f"  · {n}")
        print()
    if not problems and not notes:
        print("문제 없음")

    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
