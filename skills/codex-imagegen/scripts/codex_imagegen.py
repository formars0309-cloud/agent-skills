#!/usr/bin/env python3
"""Codex CLI 내장 image_gen을 비대화형으로 호출해 이미지를 생성·편집한다.

Claude Code 등 이미지 생성 도구가 없는 에이전트가 Bash로 호출한다.
OpenAI API 키가 필요 없고, 로그인된 Codex(ChatGPT 구독) 인증을 그대로 쓴다.

사용 예:
  생성:  codex_imagegen.py --prompt "..." --out 결과.png
  편집:  codex_imagegen.py --edit 원본.png --prompt "change only X; keep Y" --out 결과.png
  참조:  codex_imagegen.py --ref 캐릭터시트.png --prompt "..." --out 결과.png
  납품:  codex_imagegen.py ... --jpg-width 690        # PNG 옆에 690px JPG도 만든다

출력: 마지막 줄에 JSON 한 줄(결과 경로·크기·바이트·SHA256·소요 시간·토큰).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
GENERATED_DIR = CODEX_HOME / "generated_images"


def die(msg: str, code: int = 2) -> None:
    print(f"오류: {msg}", file=sys.stderr)
    sys.exit(code)


def snapshot_generated() -> set[Path]:
    if not GENERATED_DIR.exists():
        return set()
    return {p for p in GENERATED_DIR.rglob("*.png")}


def build_instruction(args: argparse.Namespace, attachments: list[tuple[str, Path]]) -> str:
    """Codex에 보낼 지시문. 도구 호출·파일 처리 규칙을 고정하고 사용자 프롬프트를 감싼다."""
    lines = [
        "You are running non-interactively as an image generation backend.",
        "Use the built-in `image_gen` tool exactly once and produce exactly ONE image.",
        "Do NOT run shell commands, do NOT move, copy, resize, or convert files, do NOT create files in the workspace.",
        "Do NOT ask questions; if something is ambiguous, make the most conservative choice that preserves the prompt.",
        "Your final message must contain ONLY the absolute path of the generated PNG on a single line, nothing else.",
        "",
    ]
    if attachments:
        lines.append("Attached images and their roles (in attachment order):")
        for idx, (role, path) in enumerate(attachments, start=1):
            lines.append(f"- Image {idx}: {role} ({path.name})")
        lines.append("")
    if args.edit:
        lines.append(
            "Mode: EDIT. Image 1 is the edit target. Apply only the requested change and keep everything else "
            "unchanged (composition, character identity, line work, colors, text, framing)."
        )
    else:
        lines.append("Mode: GENERATE a new image.")
    if args.size:
        lines.append(f"Output size / aspect: {args.size}.")
    if args.transparent:
        lines.append("Output must have a genuinely transparent background; preserve the alpha channel.")
    lines.append("")
    lines.append("=== PROMPT ===")
    lines.append(args.prompt.strip())
    lines.append("=== END PROMPT ===")
    return "\n".join(lines)


def run_codex(instruction: str, attachments: list[Path], workdir: Path, timeout: int, sandbox: str,
              model: str | None) -> tuple[int, str, str, str]:
    last_msg = workdir / "last_message.txt"
    cmd = [
        "codex", "exec", "--json", "--ephemeral",
        "-s", sandbox, "--skip-git-repo-check",
        "-C", str(workdir), "-o", str(last_msg),
    ]
    if model:
        cmd += ["-m", model]
    for p in attachments:
        cmd += ["-i", str(p)]
    cmd.append("-")  # 프롬프트는 stdin으로 — 셸 인용 문제와 길이 제한을 피한다
    proc = subprocess.run(
        cmd, input=instruction, text=True, capture_output=True, timeout=timeout,
    )
    last = last_msg.read_text().strip() if last_msg.exists() else ""
    return proc.returncode, proc.stdout, proc.stderr, last


def parse_usage(events_jsonl: str) -> dict:
    usage: dict = {}
    for line in events_jsonl.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "turn.completed" and isinstance(ev.get("usage"), dict):
            usage = ev["usage"]
    return usage


def sips_info(path: Path) -> dict:
    """macOS sips로 픽셀 크기·형식을 읽는다. sips가 없으면 빈 dict."""
    if shutil.which("sips") is None:
        return {}
    out = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", str(path)],
        capture_output=True, text=True,
    ).stdout
    info = {}
    for key in ("pixelWidth", "pixelHeight", "format"):
        m = re.search(rf"{key}:\s*(\S+)", out)
        if m:
            info[key] = int(m.group(1)) if key != "format" else m.group(1)
    return info


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def convert_jpg(src: Path, dst: Path, width: int) -> None:
    if shutil.which("sips") is None:
        die("JPG 변환에는 macOS sips가 필요합니다. --jpg-width 없이 실행하고 별도 변환하세요.")
    # 알파 채널은 흰 바탕으로 합쳐지지 않을 수 있으므로 RGB 강제 후 변환
    subprocess.run(
        ["sips", "--resampleWidth", str(width), "-s", "format", "jpeg", "-s", "formatOptions", "92",
         str(src), "--out", str(dst)],
        check=True, capture_output=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--prompt", help="생성·편집 지시문")
    g.add_argument("--prompt-file", type=Path, help="지시문 파일(UTF-8)")
    ap.add_argument("--out", type=Path, required=True, help="결과 PNG 경로(기존 파일은 --force 없이 덮어쓰지 않음)")
    ap.add_argument("--edit", type=Path, help="편집 대상 이미지(Image 1로 첨부)")
    ap.add_argument("--ref", type=Path, action="append", default=[], help="참조 이미지(반복 가능)")
    ap.add_argument("--size", help="크기·비율 힌트, 예: 1024x1536 portrait")
    ap.add_argument("--transparent", action="store_true", help="투명 배경 요청")
    ap.add_argument("--jpg-width", type=int, help="지정 폭의 JPG를 함께 만든다(예: 690)")
    ap.add_argument("--jpg-out", type=Path, help="JPG 경로(기본: --out의 확장자를 .jpg로)")
    ap.add_argument("--timeout", type=int, default=600, help="초 단위 제한(기본 600)")
    ap.add_argument("--sandbox", default="read-only", choices=["read-only", "workspace-write"],
                    help="Codex 셸 샌드박스(기본 read-only; image_gen에는 영향 없음)")
    ap.add_argument("--model", help="Codex 모델 재정의(기본: config.toml)")
    ap.add_argument("--force", action="store_true", help="기존 --out 덮어쓰기 허용")
    ap.add_argument("--keep-source", action="store_true",
                    help="CODEX_HOME/generated_images의 원본을 남긴다(기본은 복사 후 삭제)")
    args = ap.parse_args()

    if args.prompt_file:
        args.prompt = args.prompt_file.read_text(encoding="utf-8")
    if not args.prompt or not args.prompt.strip():
        die("프롬프트가 비어 있습니다.")
    if shutil.which("codex") is None:
        die("codex CLI를 찾을 수 없습니다. Codex 설치와 로그인(codex login)을 확인하세요.")
    if args.out.exists() and not args.force:
        die(f"결과 파일이 이미 있습니다: {args.out} (원본 보존 — 다른 이름을 쓰거나 --force)")

    attachments: list[tuple[str, Path]] = []
    if args.edit:
        if not args.edit.exists():
            die(f"편집 대상이 없습니다: {args.edit}")
        attachments.append(("edit target", args.edit.resolve()))
    for r in args.ref:
        if not r.exists():
            die(f"참조 이미지가 없습니다: {r}")
        attachments.append(("reference image (style/character/composition guidance only)", r.resolve()))

    instruction = build_instruction(args, attachments)
    before = snapshot_generated()
    t0 = time.time()

    with tempfile.TemporaryDirectory(prefix="codex-imagegen-") as tmp:
        workdir = Path(tmp)
        try:
            rc, stdout, stderr, last = run_codex(
                instruction, [p for _, p in attachments], workdir, args.timeout, args.sandbox, args.model,
            )
        except subprocess.TimeoutExpired:
            die(f"{args.timeout}초 안에 끝나지 않았습니다.", 3)

    elapsed = round(time.time() - t0, 1)
    new_files = sorted(snapshot_generated() - before, key=lambda p: p.stat().st_mtime)

    # 결과 경로 결정: 마지막 메시지의 경로 → 새로 생긴 파일 중 최신
    source: Path | None = None
    m = re.search(r"(/\S+?\.png)", last)
    if m and Path(m.group(1)).exists():
        source = Path(m.group(1))
    elif new_files:
        source = new_files[-1]

    if source is None:
        print(stderr[-2000:], file=sys.stderr)
        print(last, file=sys.stderr)
        die(f"생성된 이미지를 찾지 못했습니다(codex exit={rc}).", 4)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, args.out)
    if not args.keep_source:
        # 이 실행이 확정한 원본만 지운다. 병렬 실행의 파일을 건드리지 않도록 new_files 전체를 지우지 않는다.
        try:
            source.unlink()
        except OSError:
            pass
        # 세션 폴더가 비면 같이 정리
        try:
            source.parent.rmdir()
        except OSError:
            pass

    result = {
        "out": str(args.out.resolve()),
        "bytes": args.out.stat().st_size,
        "sha256": sha256(args.out),
        **{k: v for k, v in sips_info(args.out).items()},
        "mode": "edit" if args.edit else "generate",
        "attachments": [str(p) for _, p in attachments],
        "new_files_seen": len(new_files),
        "seconds": elapsed,
        "usage": parse_usage(stdout),
        "codex_exit": rc,
    }

    if args.jpg_width:
        jpg = args.jpg_out or args.out.with_suffix(".jpg")
        if jpg.exists() and not args.force:
            die(f"JPG가 이미 있습니다: {jpg}")
        convert_jpg(args.out, jpg, args.jpg_width)
        result["jpg"] = {
            "path": str(jpg.resolve()),
            "bytes": jpg.stat().st_size,
            "sha256": sha256(jpg),
            **sips_info(jpg),
        }

    print(f"완료: {result['out']} ({result.get('pixelWidth')}x{result.get('pixelHeight')}, "
          f"{result['bytes']:,}B, {elapsed}s)", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
