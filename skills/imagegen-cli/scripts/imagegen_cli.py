#!/usr/bin/env python3
"""구독 로그인된 CLI(Codex·Grok)의 내장 이미지 도구를 비대화형으로 호출해 이미지를 생성·편집한다.

Claude Code 등 이미지 생성 도구가 없는 에이전트가 Bash로 호출한다.
API 키가 필요 없고, 각 CLI의 로그인 인증(ChatGPT 구독·grok.com 구독)을 그대로 쓴다.

백엔드:
  codex (기본)  Codex 내장 image_gen(gpt-image). 결과 PNG. 편집·참조는 `codex exec -i`로 첨부.
  grok          Grok CLI 내장 image_gen / image_edit(xAI Imagine). 결과 JPG. 편집·참조는 절대 경로로 전달.

사용 예:
  생성:  imagegen_cli.py --prompt "..." --out 결과.png
  편집:  imagegen_cli.py --edit 원본.png --prompt "change only X; keep Y" --out 결과.png
  참조:  imagegen_cli.py --ref 캐릭터시트.png --prompt "..." --out 결과.png
  Grok:  imagegen_cli.py --backend grok --aspect 2:3 --prompt "..." --out 결과.jpg
  납품:  imagegen_cli.py ... --jpg-width 690        # 결과 옆에 690px JPG도 만든다

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
from urllib.parse import quote

CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
CODEX_GENERATED = CODEX_HOME / "generated_images"
GROK_HOME = Path(os.environ.get("GROK_HOME", Path.home() / ".grok"))
GROK_SESSIONS = GROK_HOME / "sessions"

GROK_GEN_RATIOS = {"auto", "1:1", "16:9", "9:16", "3:2", "2:3"}


def die(msg: str, code: int = 2) -> None:
    print(f"오류: {msg}", file=sys.stderr)
    sys.exit(code)


# ---------- 공통 ----------

def common_rules(args: argparse.Namespace) -> list[str]:
    lines = [
        "You are running non-interactively as an image generation backend.",
        "Produce exactly ONE image with a single image tool call.",
        "Do NOT write code, do NOT draw a fallback image, do NOT move, copy, resize, or convert files.",
        "Do NOT ask questions; if something is ambiguous, make the most conservative choice that preserves the prompt.",
    ]
    if args.transparent:
        lines.append("Output must have a genuinely transparent background; preserve the alpha channel.")
    return lines


def prompt_block(args: argparse.Namespace) -> list[str]:
    return ["", "=== PROMPT ===", args.prompt.strip(), "=== END PROMPT ==="]


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


def sips_convert(src: Path, dst: Path, width: int | None = None) -> None:
    if shutil.which("sips") is None:
        die("형식 변환에는 macOS sips가 필요합니다. 결과 확장자를 원본과 같게 지정하세요.")
    fmt = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "webp"}.get(dst.suffix.lower().lstrip("."))
    if fmt is None:
        die(f"지원하지 않는 출력 확장자: {dst.suffix}")
    cmd = ["sips"]
    if width:
        cmd += ["--resampleWidth", str(width)]
    cmd += ["-s", "format", fmt]
    if fmt == "jpeg":
        cmd += ["-s", "formatOptions", "92"]
    cmd += [str(src), "--out", str(dst)]
    subprocess.run(cmd, check=True, capture_output=True)


def place_output(source: Path, out: Path) -> None:
    """원본을 --out으로 옮긴다. 확장자가 다르면 변환, 같으면 그대로 복사."""
    out.parent.mkdir(parents=True, exist_ok=True)
    same = source.suffix.lower().lstrip(".") in ("jpg", "jpeg") and out.suffix.lower().lstrip(".") in ("jpg", "jpeg")
    if same or source.suffix.lower() == out.suffix.lower():
        shutil.copy2(source, out)
    else:
        sips_convert(source, out)


# ---------- Codex ----------

def codex_snapshot() -> set[Path]:
    return set(CODEX_GENERATED.rglob("*.png")) if CODEX_GENERATED.exists() else set()


def codex_instruction(args: argparse.Namespace, attachments: list[tuple[str, Path]]) -> str:
    lines = common_rules(args)
    lines += [
        "Use the built-in `image_gen` tool exactly once. Do NOT run shell commands and do NOT create files in the workspace.",
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
    elif args.aspect and args.aspect != "auto":
        lines.append(f"Output aspect ratio: {args.aspect}.")
    return "\n".join(lines + prompt_block(args))


def run_codex(args, attachments: list[tuple[str, Path]]) -> tuple[Path | None, dict, str]:
    before = codex_snapshot()
    with tempfile.TemporaryDirectory(prefix="codex-imagegen-") as tmp:
        workdir = Path(tmp)
        last_msg = workdir / "last_message.txt"
        cmd = ["codex", "exec", "--json", "--ephemeral", "-s", args.sandbox, "--skip-git-repo-check",
               "-C", str(workdir), "-o", str(last_msg)]
        if args.model:
            cmd += ["-m", args.model]
        for _, p in attachments:
            cmd += ["-i", str(p)]
        cmd.append("-")  # 프롬프트는 stdin으로 — 셸 인용 문제와 길이 제한을 피한다
        try:
            proc = subprocess.run(cmd, input=codex_instruction(args, attachments), text=True,
                                  capture_output=True, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            die(f"{args.timeout}초 안에 끝나지 않았습니다.", 3)
        last = last_msg.read_text().strip() if last_msg.exists() else ""

    usage: dict = {}
    for line in proc.stdout.splitlines():
        if line.startswith("{"):
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "turn.completed" and isinstance(ev.get("usage"), dict):
                usage = ev["usage"]

    new_files = sorted(codex_snapshot() - before, key=lambda p: p.stat().st_mtime)
    source: Path | None = None
    m = re.search(r"(/\S+?\.png)", last)
    if m and Path(m.group(1)).exists():
        source = Path(m.group(1))
    elif new_files:
        source = new_files[-1]
    diag = (proc.stderr[-2000:] + "\n" + last) if source is None else ""
    return source, {"usage": usage, "codex_exit": proc.returncode}, diag


def codex_cleanup(source: Path) -> None:
    # 이 실행이 확정한 원본만 지운다. 병렬 실행의 파일을 건드리지 않도록 폴더 전체를 지우지 않는다.
    try:
        source.unlink()
        source.parent.rmdir()
    except OSError:
        pass


# ---------- Grok ----------

def grok_instruction(args: argparse.Namespace, attachments: list[tuple[str, Path]]) -> str:
    lines = common_rules(args)
    if attachments:
        paths = [str(p) for _, p in attachments]
        lines.append("Use the `image_edit` tool exactly once with `image` set to exactly these absolute paths, in this order:")
        for idx, (role, path) in enumerate(attachments, start=1):
            lines.append(f"  {idx}. {path}  ({role})")
        if args.edit:
            lines.append(
                "Mode: EDIT. The first image is the edit target. Apply only the requested change and keep everything "
                "else unchanged (composition, character identity, line work, colors, text, framing)."
            )
        else:
            lines.append("Mode: GENERATE guided by the reference image(s); do not copy them, use them for style/character/composition.")
        if args.aspect and args.aspect != "auto" and (len(paths) > 1 or not args.edit):
            lines.append(f"Set `aspect_ratio` to \"{args.aspect}\".")
    else:
        lines.append("Use the `image_gen` tool exactly once.")
        ratio = args.aspect or "auto"
        if ratio not in GROK_GEN_RATIOS:
            ratio = nearest_ratio(ratio, GROK_GEN_RATIOS)
        lines.append(f"Set `aspect_ratio` to \"{ratio}\".")
    lines.append("After the tool returns, reply with only the absolute path it reported.")
    return "\n".join(lines + prompt_block(args))


def nearest_ratio(want: str, allowed: set[str]) -> str:
    try:
        w, h = (float(x) for x in want.split(":"))
    except ValueError:
        return "auto"
    best, best_d = "auto", 1e9
    for r in allowed - {"auto"}:
        rw, rh = (float(x) for x in r.split(":"))
        d = abs(rw / rh - w / h)
        if d < best_d:
            best, best_d = r, d
    return best


def run_grok(args, attachments: list[tuple[str, Path]]) -> tuple[Path | None, dict, str]:
    with tempfile.TemporaryDirectory(prefix="grok-imagegen-") as tmp:
        workdir = Path(tmp)
        cmd = ["grok", "-p", grok_instruction(args, attachments), "--always-approve",
               "--output-format", "streaming-json", "--cwd", str(workdir),
               "--tools", "image_gen,image_edit"]  # 셸·파일 도구를 빼서 대체 그림·변환을 원천 차단
        if args.model:
            cmd += ["--model", args.model]
        try:
            proc = subprocess.run(cmd, text=True, capture_output=True, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            die(f"{args.timeout}초 안에 끝나지 않았습니다.", 3)
        session_root = GROK_SESSIONS / quote(str(workdir), safe="")

        source: Path | None = None
        tool_used = None
        for line in proc.stdout.splitlines():
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "tool_call" and ev.get("toolName") in ("image_gen", "image_edit"):
                tool_used = ev["toolName"]
            if ev.get("type") == "tool_call_update" and ev.get("status") == "completed":
                for c in ev.get("content", []):
                    text = c.get("content", {}).get("text", "")
                    m = re.search(r'"path"\s*:\s*"([^"]+)"', text)
                    if m and Path(m.group(1)).exists():
                        source = Path(m.group(1))
        if source is None and session_root.exists():
            cands = sorted(session_root.rglob("images/*.*"), key=lambda p: p.stat().st_mtime)
            if cands:
                source = cands[-1]

        # 세션 폴더는 임시 작업 폴더에 묶여 있으므로 결과를 옮긴 뒤 통째로 정리한다
        staged: Path | None = None
        if source is not None:
            staged = Path(tempfile.mkstemp(prefix="grok-img-", suffix=source.suffix)[1])
            shutil.copy2(source, staged)
            if not args.keep_source:
                shutil.rmtree(session_root, ignore_errors=True)
        diag = (proc.stderr[-2000:] + "\n" + proc.stdout[-1500:]) if source is None else ""
        return staged, {"tool": tool_used, "grok_exit": proc.returncode}, diag


# ---------- main ----------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--prompt", help="생성·편집 지시문")
    g.add_argument("--prompt-file", type=Path, help="지시문 파일(UTF-8)")
    ap.add_argument("--out", type=Path, required=True,
                    help="결과 경로(.png/.jpg; 백엔드 원본과 확장자가 다르면 변환). 기존 파일은 --force 없이 덮어쓰지 않음")
    ap.add_argument("--backend", choices=["codex", "grok"], default="codex", help="이미지 백엔드(기본 codex)")
    ap.add_argument("--edit", type=Path, help="편집 대상 이미지(Image 1로 첨부)")
    ap.add_argument("--ref", type=Path, action="append", default=[], help="참조 이미지(반복 가능)")
    ap.add_argument("--aspect", help="비율, 예: 2:3 (grok: 도구 인자, codex: 프롬프트 힌트)")
    ap.add_argument("--size", help="codex 전용 크기 힌트, 예: 1024x1536 portrait")
    ap.add_argument("--transparent", action="store_true", help="투명 배경 요청")
    ap.add_argument("--jpg-width", type=int, help="지정 폭의 JPG를 함께 만든다(예: 690)")
    ap.add_argument("--jpg-out", type=Path, help="JPG 경로(기본: --out의 확장자를 .jpg로)")
    ap.add_argument("--timeout", type=int, default=600, help="초 단위 제한(기본 600)")
    ap.add_argument("--sandbox", default="read-only", choices=["read-only", "workspace-write"],
                    help="codex 셸 샌드박스(기본 read-only; image_gen에는 영향 없음)")
    ap.add_argument("--model", help="CLI 모델 재정의(기본: 각 CLI 설정)")
    ap.add_argument("--force", action="store_true", help="기존 --out 덮어쓰기 허용")
    ap.add_argument("--keep-source", action="store_true", help="CLI 쪽 원본을 남긴다(기본은 복사 후 삭제)")
    args = ap.parse_args()

    if args.prompt_file:
        args.prompt = args.prompt_file.read_text(encoding="utf-8")
    if not args.prompt or not args.prompt.strip():
        die("프롬프트가 비어 있습니다.")
    if shutil.which(args.backend) is None:
        die(f"{args.backend} CLI를 찾을 수 없습니다. 설치와 로그인을 확인하세요.")
    if args.out.exists() and not args.force:
        die(f"결과 파일이 이미 있습니다: {args.out} (원본 보존 — 다른 이름을 쓰거나 --force)")
    if args.backend == "grok" and args.transparent:
        die("grok 백엔드는 투명 배경을 지원하지 않습니다.")

    attachments: list[tuple[str, Path]] = []
    if args.edit:
        if not args.edit.exists():
            die(f"편집 대상이 없습니다: {args.edit}")
        attachments.append(("edit target", args.edit.resolve()))
    for r in args.ref:
        if not r.exists():
            die(f"참조 이미지가 없습니다: {r}")
        attachments.append(("reference image (style/character/composition guidance only)", r.resolve()))

    t0 = time.time()
    runner = run_codex if args.backend == "codex" else run_grok
    source, extra, diag = runner(args, attachments)
    elapsed = round(time.time() - t0, 1)
    if source is None:
        print(diag, file=sys.stderr)
        die(f"생성된 이미지를 찾지 못했습니다 ({args.backend}).", 4)

    place_output(source, args.out)
    if args.backend == "codex" and not args.keep_source:
        codex_cleanup(source)
    if args.backend == "grok":
        source.unlink(missing_ok=True)  # 임시 사본

    result = {
        "out": str(args.out.resolve()),
        "backend": args.backend,
        "bytes": args.out.stat().st_size,
        "sha256": sha256(args.out),
        **sips_info(args.out),
        "mode": "edit" if args.edit else "generate",
        "attachments": [str(p) for _, p in attachments],
        "seconds": elapsed,
        **extra,
    }

    if args.jpg_width:
        jpg = args.jpg_out or args.out.with_suffix(".jpg")
        if jpg.resolve() == args.out.resolve():
            jpg = args.out.with_name(args.out.stem + f"-{args.jpg_width}.jpg")
        if jpg.exists() and not args.force:
            die(f"JPG가 이미 있습니다: {jpg}")
        sips_convert(args.out, jpg, args.jpg_width)
        result["jpg"] = {"path": str(jpg.resolve()), "bytes": jpg.stat().st_size, "sha256": sha256(jpg), **sips_info(jpg)}

    print(f"완료[{args.backend}]: {result['out']} ({result.get('pixelWidth')}x{result.get('pixelHeight')}, "
          f"{result['bytes']:,}B, {elapsed}s)", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
