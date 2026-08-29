---
name: citation-verify
description: Verify that biomedical citations are real, correctly attributed, and not retracted, by resolving DOIs/PMIDs/PMCIDs against PubMed, Crossref and Europe PMC. Use when writing, reviewing, or fact-checking a medical or scientific manuscript, when the user says "인용 검증", "레퍼런스 확인", "이 논문 실제로 있는지", "check citations", "verify references", "is this paper real", "retracted", "PMID 확인", "DOI 확인", or before delivering any text that contains references. Also use to FIND a correct citation to replace an unverified one.
---

# Citation verification

Language models fabricate citations that look correct: a plausible title, real-sounding
authors, and a well-formed PMID or DOI that belongs to a different paper or to nothing at
all. Never assert that a reference is genuine from memory. Resolve it.

**The rule: any citation that reaches the user must have been resolved by this tool, or be
labelled as unverified.** This applies to citations you wrote and to citations the user
supplied.

## Tool

```bash
node ~/.claude/skills/citation-verify/scripts/verify.mjs <command>
```

On Windows PowerShell use the full path:
`node $env:USERPROFILE\.claude\skills\citation-verify\scripts\verify.mjs <command>`

### Commands

**`check <file...>`** — the main workflow. Extracts every DOI, PMID and PMCID from the
file(s) and verifies each one. Run this on any draft containing references.

```bash
node .../verify.mjs check manuscript.md references.bib
```

**`verify`** — resolve one citation, comparing claimed metadata against the live record.
Pass whatever the citation claims; each field given is checked.

```bash
node .../verify.mjs verify --pmid 32109013 \
  --title "Clinical Characteristics of Coronavirus Disease 2019 in China" \
  --author "Guan" --year 2020 --journal "N Engl J Med"
```

Flags: `--pmid` `--doi` `--pmcid` `--title` `--author` `--year` `--journal` `--json`

Passing `--title` alone (no identifier) does a reverse lookup: if no record matches, the
citation is likely fabricated.

**`search "<query>"`** — find the real paper, to replace a citation that failed.

```bash
node .../verify.mjs search "tirzepatide obesity randomized trial" --limit 5
```

Europe PMC query syntax works: `TITLE:"..."`, `AUTH:"Smith J"`, `DOI:"10.xxxx/yyy"`,
`PMID:12345678`, and boolean `AND` / `OR`.

## Verdicts

| Verdict | Meaning | Action |
|---|---|---|
| `OK` | Exists and claimed metadata matches | Safe to cite |
| `SUSPECT` | Exists, but title/author/year/journal partially disagrees | Inspect; likely wrong ID or sloppy reference |
| `MISMATCH` | Identifier is real but belongs to a **different paper** | **Fabricated.** Remove or replace |
| `NOT_FOUND` | Identifier does not exist in any registry | **Fabricated.** Remove or replace |
| `RETRACTED` | Real paper, but **retracted** | Do not cite as evidence |
| `ERROR` | Network/registry failure | Retry; do NOT report as verified |

Exit code is `1` if any citation is `NOT_FOUND`, `MISMATCH` or `RETRACTED`, else `0`.

## Workflow

1. Run `check` on the draft.
2. For every `NOT_FOUND` / `MISMATCH`, do **not** guess a replacement identifier. Run
   `search` with the topic to find a real paper, then re-verify the replacement.
3. For every `RETRACTED`, tell the user explicitly, name the retraction, and remove the
   claim it supported unless the user is deliberately discussing the retraction.
4. For `SUSPECT`, show the claimed vs. actual metadata side by side and let the user decide.
5. Report counts honestly. If a lookup errored, say it was not verified — never round an
   `ERROR` up to `OK`.

## Reporting

State what was checked and what failed. Do not bury a retraction or a fabricated reference
in a summary line. Example:

> 12 references checked: 9 OK, 1 suspect, 2 failed.
> - PMID 91234567 (ref 3) — does not exist. Replaced with PMID 34567890 after searching.
> - DOI 10.1016/S0140-6736(20)31180-6 (ref 7) — **retracted** (Lancet, 2020, Surgisphere).

## Notes

- All three registries are free and need no API key. NCBI allows ~3 requests/sec
  anonymously; the script batches PMIDs and paces itself. Set `CONTEXT7_API_KEY`-style keys
  are **not** needed here.
- Coverage is biomedical. Non-biomedical DOIs still resolve via Crossref, but PubMed
  retraction screening only applies to indexed literature.
- A `year` off by one is normal (online-first vs. print) and is reported but not failed.
- Preprints (bioRxiv/medRxiv) resolve via Crossref and Europe PMC; flag them to the user as
  non-peer-reviewed.
