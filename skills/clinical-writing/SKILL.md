---
name: clinical-writing
description: Discipline for producing clinical content a clinician will act on - drug doses, target values, thresholds, management steps, guideline recommendations, anesthesia/ICU/perioperative plans, differential and workup summaries. Load BEFORE drafting, not after. Use when the user asks about 마취, 용량, 목표치, 프로토콜, 가이드라인, 약제, 환자 관리, 술기, or says "정리해줘"/"알려줘" about a clinical topic; and for "what dose", "what target", "how do I manage", "summarize the management of", "protocol for". Enforces guideline lookup before drafting, a source label on every number, format rules that stop conditions being flattened, and cross-model review before delivery. Companion to [[citation-verify]], which checks references after text exists; this one governs the writing itself.
---

# Clinical writing

The reader is a clinician who will act on this within minutes. A stale number is
not a typo — it is a dose given, a target dialled in, a drug withheld.

## The failure mode this exists to stop

Recall on clinical topics fails in a specific, predictable way. Measured on a real
draft (acute aortic dissection anesthesia, 14 defects found on review):

| Failure | Share | Example |
|---|---|---|
| Superseded guideline value stated as current | 4/14 | "HR <60" — the pre-2022 target; 2022 ACC/AHA says 60–80 |
| Two adjacent facts fused into a false claim | 3/14 | ">20 mmHg inter-arm difference → pseudohypotension" |
| Conditional statement flattened to an absolute | 2/14 | "Avoid ketamine" — true in the hypertensive patient, wrong in tamponade |
| Specific figure with no source | 1/14 | "Stroke 5–10%" |
| Common practice presented as recommendation | 1/14 | Head packing in ice |
| Regimen recalled incompletely | 1/14 | TXA high-dose, pump-prime component dropped |
| Starting parameter written as an endpoint | 2/14 | ACP flow and pressure |

**Nothing was invented.** No fake drug, no fake mechanism, no fake trial. Every
defect was something once true, or still partly true, that had gone stale or been
crushed flat.

That matters, because it means the error produces **no internal signal**. It reads
as confident and correct from the inside. Care and self-review do not catch it.
Only an external lookup does.

Two structural causes, and both are permanent:

1. **Superseded guidance outweighs current guidance in training text.** A target
   that stood for fifteen years appears in far more documents than the value that
   replaced it three years ago. Frequency-weighted recall returns the old one.
   Where a guideline has been revised, expect to be wrong.
2. **Presentation compresses.** A table cell holds one value; a bold imperative
   holds no exceptions; an arrow asserts causation. The tidier the layout, the
   more of the clinical condition it deletes. The compression errors above all
   arrived inside tables and bullets.

## Rules

### 1. Look it up before drafting

For any guideline-governed topic, retrieve the current recommendation **before**
writing, not as a check afterwards. Verifying a finished draft is far weaker: by
then the wrong number is already written, reads fluently, and will be defended.

Always look up:

- targets, thresholds, and cutoffs of any kind
- anything revised in the last ~5 years
- anything remembered as "the target is X" with no memory of where X came from
- society guidelines by name — confirm the year and the exact wording

Budget: about a minute. It is always cheaper than the alternative.

### 2. Every number carries a label

No exceptions. Doses, targets, thresholds, rates, incidences, durations.

| Label | Meaning |
|---|---|
| `[권고]` | Stated in a named guideline. Name it: `[권고 2022 ACC/AHA]` |
| `[관행]` | Widely practised, no guideline backing |
| `[미확인]` | From recall, not checked |

`[미확인]` is an acceptable thing to publish. Silence is not. The label makes
verification cheaper than concealment, which is the entire point.

Run `scripts/lint.mjs` on the draft — it fails any quantity that carries no label.

### 3. A table that deletes the condition is the wrong table

If a value depends on the patient's state, the state gets a column:

```
BAD                          GOOD
| Target | SBP <120 |        | State          | Target              |
                             | No tamponade   | SBP <120            |
                             | Tamponade      | Lowest that perfuses |
```

If the state column cannot be built, drop the table and write prose. Prose has
room for "except when"; a cell does not.

### 4. Split the states before outlining

Cut the slots at outline time — prevention vs rescue, initial vs refractory,
stable vs unstable, adult vs paediatric. Merging them later is impossible; by
then one number is standing in for two clinical situations, which is how
"prevention MAP 80–90" swallowed "rescue MAP >100".

### 5. Never absolutise

"Avoid X", "never do Y", "contraindicated" — state the population it holds for.
A blanket prohibition that is wrong in the crashing patient is worse than no
guidance, because it is most misleading exactly when the stakes are highest.

Write "generally avoid in A; reasonable in B", not "avoid".

### 6. Cross-review before delivery

High-stakes clinical content goes to a second model before it reaches the user:

Pipe the draft in on stdin. Interpolating it into the argument (`"... $(cat
draft.md)"`) works until the draft grows, then dies with `Argument list too
long` — on Windows that ceiling arrives around 20 KB, which a finished document
reaches easily.

```bash
{ cat review-prompt.txt; cat draft.md; } | \
  codex exec --skip-git-repo-check -s read-only -
```

with `review-prompt.txt` holding: *You are a senior &lt;specialty&gt; physician.
Review for: (1) factual errors — quote the line, give the correct value; (2)
outdated practice; (3) missing current agents; (4) where you are uncertain, say
so. Do not invent citations.*

Very long documents also stall as one request. Split by section into pieces of
roughly 3–6 KB and review each; the findings come back sharper as well, since
the reviewer is not skimming. Keep one whole-document pass for contradictions
between sections.

A different training distribution catches different errors. On the dissection
draft, self-review found 2 of the 14; cross-review found the other 3 of the
serious ones, including the headline target. Do not skip this because the draft
feels solid — feeling solid is the failure mode, not evidence against it.

### 7. Hand off to citation-verify

Once the text exists and carries references, run [[citation-verify]] over it.
This skill governs whether the claims are current; that one governs whether the
sources are real. Both are needed.

## The linter

```bash
node ~/.claude/skills/clinical-writing/scripts/lint.mjs draft.md
```

Exit `1` if anything is unlabelled. Three findings:

| | |
|---|---|
| `[UNLABELLED]` | A quantity with no source. **Error.** |
| `[UNRESOLVED]` | A guideline named with no PMID/DOI. **Warning** — naming a document is not reading it |
| `[ABSOLUTE]` | "never" / "금기" / "avoid" with no population. **Warning** |

Run it on the dissection draft that motivated this skill and it returns 14
unlabelled quantities and 4 warnings — among them the pseudohypotension claim,
the fibrinogen target, the unsourced stroke rate, and, as `[UNRESOLVED]`, the
line that named the 2022 guideline while quoting the pre-2022 number.

What it cannot do is tell you the cited guideline says something else. Only
Rule 1 catches that. The linter enforces that a claim declares its source; it
cannot check the source is current. Do not let a clean run stand in for the
lookup.

## Delivering

State the verification status plainly, as a table, not buried in prose:

> | | |
> |---|---|
> | Guideline values | ✅ looked up, 2022 ACC/AHA |
> | References | ✅ 12 verified, 0 retracted |
> | Cross-review | ✅ Codex, 3 corrections applied |
> | Doses | ⚠️ recall-based — check against local formulary |

Never let a document imply sourcing it does not have. Naming a guideline in the
body without having opened it is worse than citing nothing: it manufactures
authority and removes the reader's reason to check.

If the user has to ask "is this verified?", the answer should already have been
on the page.
