#!/usr/bin/env node
/**
 * Lint for clinical drafts.
 *
 * Rule 2 of the clinical-writing skill says every quantity a clinician could act
 * on must declare where it came from. This checks that mechanically, because the
 * failure it guards against produces no internal signal: a stale dose reads
 * exactly like a current one.
 *
 *   node lint.mjs draft.md [more.md ...]
 *
 * Errors  (exit 1): a dose / target / threshold / rate with no source label.
 * Warnings(exit 0): an absolute instruction with no population attached.
 *
 * A quantity counts as labelled when its line, or the scope it sits in, carries
 * one of [권고] [관행] [미확인] / [GUIDE] [PRACTICE] [UNVERIFIED], or a real
 * citation (PMID, DOI, or a society acronym with a year).
 *
 * Scope labels let a whole section inherit one source, so tables stay readable:
 *
 *   ## Anti-impulse targets [권고 2022 ACC/AHA]     <- until the next heading
 *   <!-- label: 미확인 -->                          <- until the next heading
 */

import { readFileSync } from 'node:fs';

/* ---------- what counts as a quantity ---------- */

const NUM = String.raw`\d+(?:[.,]\d+)?(?:\s*(?:[-–—~]|to)\s*\d+(?:[.,]\d+)?)?`;

// Mass / volume / activity, optionally per weight and per time: "30 mg/kg", "16 mg/kg/hr".
const DOSE_UNIT = String.raw`(?:mcg|µg|ug|mg|ng|kg|g|mL|ml|L|IU|U|mEq|mmol)`;
const PER = String.raw`(?:\s*\/\s*(?:kg|min|hr|h|day|dL|L|m2|mo|wk))*`;

// Physiologic targets and rates, plus bare percentages (incidence figures).
const PHYS_UNIT = String.raw`(?:mmHg|cmH2O|cmH₂O|bpm|°\s*C|℃|C\b|g\/dL|mg\/dL|g\/L|mmol\/L|mOsm|%)`;

const QUANTITY = new RegExp(
  `(?:${NUM})\\s*(?:${DOSE_UNIT}${PER}|${PHYS_UNIT})`,
  'gi'
);

/* ---------- what counts as a source ---------- */

// Markdown writes the label as [권고 ...]; HTML writes it as a chip element.
const LABEL = /\[\s*(권고|관행|미확인|GUIDE|PRACTICE|UNVERIFIED)|class\s*=\s*"[^"]*\bsrc\b/i;
const CITATION = /\b(PMID|PMCID|DOI|doi:)\b|\b10\.\d{4,9}\//i;
// A society acronym next to a year, e.g. "2022 ACC/AHA", "EACTS/STS 2024".
const SOCIETY_YEAR = /\b(?:19|20)\d{2}\b[^\n]{0,40}\b[A-Z]{2,}(?:\/[A-Z]{2,})*\b|\b[A-Z]{2,}(?:\/[A-Z]{2,})*\b[^\n]{0,40}\b(?:19|20)\d{2}\b/;

function isSourced(line) {
  return LABEL.test(line) || CITATION.test(line) || SOCIETY_YEAR.test(line);
}

/**
 * Naming a guideline is not the same as having opened it. The worst defect in
 * the draft that motivated this skill sat on a line reading "(cited as 2022
 * ACC/AHA)" while stating the pre-2022 target - the name alone made the claim
 * look sourced and removed any reason to check. So a society-and-year mention
 * with no resolvable identifier is called out rather than accepted.
 */
function namesGuidelineWithoutId(line) {
  return SOCIETY_YEAR.test(line) && !CITATION.test(line);
}

/* ---------- absolutes without a population ---------- */

// "절대" also means "absolute" (절대 혈압), so only count it when it is doing
// prohibition work - followed by a negative, or written as 절대로.
const ABSOLUTE =
  /(절대로|절대\s*(?:안|못|하지|불가|금지)|금기|하지\s*마|해서는\s*안\s*(?:된|됩)|\bnever\b|\balways\b|\bcontraindicated\b|\bmust not\b)/i;
const CONDITION =
  /(단,|다만|예외|경우|환자|상황|일 때|시에|~하면|\bexcept\b|\bunless\b|\bif\b|\bwhen\b|\bin patients\b|\bwithout\b)/i;

/* ---------- lines we never judge ---------- */

// Table separators, horizontal rules, and the skill's own label legend.
const SKIP_LINE = /^\s*\|?[\s:|-]+\|?\s*$|^\s*(?:[-*_]\s*){3,}$/;

function isHeading(line) {
  return /^\s{0,3}#{1,6}\s/.test(line) || /<h[1-6]\b/i.test(line);
}

// Inline style attributes carry percentages and hex values, not doses.
function stripStyleAttrs(line) {
  return line.replace(/\bstyle\s*=\s*"[^"]*"/gi, '');
}

function scopeLabelFrom(line) {
  const html = line.match(/<!--\s*label:\s*([^>]*?)\s*-->/i);
  if (html) return html[1];
  // A heading carrying a real citation scopes just as well as one carrying a
  // keyword label - "## Risk [IRAD 2025 · PMID 39999651]" sources the table
  // under it, and demanding the identifier be repeated in every row would push
  // toward stripping it out instead.
  if (isHeading(line) && isSourced(line)) return line;
  return null;
}

/* ---------- the pass ---------- */

function lintFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { path, read: e.message, errors: [], warnings: [] };
  }

  const lines = text.split(/\r?\n/);
  const errors = [];
  const warnings = [];

  let inFence = false;
  let inStyle = false; // <style>/<script> - hex colours and percentages are not doses
  let scope = null; // inherited label, cleared at the next heading

  lines.forEach((line, i) => {
    const n = i + 1;

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    if (/<\s*(style|script)\b/i.test(line)) inStyle = true;
    if (inStyle) {
      if (/<\s*\/\s*(style|script)\s*>/i.test(line)) inStyle = false;
      return;
    }

    const newScope = scopeLabelFrom(line);
    if (newScope !== null) {
      scope = newScope;
      return;
    }
    // A heading without a label ends the previous section's inherited source.
    if (isHeading(line)) {
      scope = null;
      return;
    }

    if (SKIP_LINE.test(line) || !line.trim()) return;

    // Markdown carries its source on the heading; HTML carries it on the
    // neighbouring tag. Treat a citation one or two lines away as covering the
    // claim - otherwise every table cell has to repeat the PMID, and the
    // pressure is then to delete it rather than repeat it.
    const near = [lines[i - 2], lines[i - 1], lines[i + 1]]
      .filter(Boolean)
      .some((l) => isSourced(l));

    const covered = isSourced(line) || near || (scope !== null && isSourced(scope));

    if (!covered) {
      const hits = [...stripStyleAttrs(line).matchAll(QUANTITY)].map((m) => m[0].trim());
      if (hits.length) {
        errors.push({ n, hits: [...new Set(hits)], line: line.trim() });
      }
    }

    if (ABSOLUTE.test(line) && !CONDITION.test(line)) {
      const next = lines[i + 1] || '';
      if (!CONDITION.test(next)) {
        warnings.push({ kind: 'ABSOLUTE', n, line: line.trim() });
      }
    }

    if (namesGuidelineWithoutId(line)) {
      warnings.push({ kind: 'UNRESOLVED', n, line: line.trim() });
    }
  });

  return { path, read: null, errors, warnings };
}

/* ---------- output ---------- */

function clip(s, max = 100) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (!files.length) {
    console.log('usage: node lint.mjs <file.md> [...]');
    console.log('');
    console.log('Flags every dose/target/threshold that carries no source label.');
    console.log('Label a line with [권고 <guideline>] / [관행] / [미확인], cite a');
    console.log('PMID or DOI, or put the label on the section heading to cover it.');
    return 2;
  }

  let totalErr = 0;
  let totalWarn = 0;

  for (const f of files) {
    const r = lintFile(f);

    if (r.read) {
      console.log(`\n${r.path}\n  cannot read: ${r.read}`);
      totalErr++;
      continue;
    }

    console.log(`\n${r.path}`);

    if (!r.errors.length && !r.warnings.length) {
      console.log('  clean');
      continue;
    }

    for (const e of r.errors) {
      console.log(`  [UNLABELLED] line ${e.n}: ${e.hits.join(', ')}`);
      console.log(`               ${clip(e.line)}`);
    }
    for (const w of r.warnings) {
      if (w.kind === 'UNRESOLVED') {
        console.log(`  [UNRESOLVED] line ${w.n}: guideline named, no PMID/DOI - did you open it?`);
      } else {
        console.log(`  [ABSOLUTE]   line ${w.n}: no population given`);
      }
      console.log(`               ${clip(w.line)}`);
    }

    totalErr += r.errors.length;
    totalWarn += r.warnings.length;
  }

  console.log('\n---');
  console.log(`${totalErr} unlabelled quantit${totalErr === 1 ? 'y' : 'ies'} | ${totalWarn} bare absolute${totalWarn === 1 ? '' : 's'}`);
  if (totalErr) {
    console.log('Label each one, or look it up and cite it. [미확인] is allowed; silence is not.');
  }

  return totalErr ? 1 : 0;
}

process.exitCode = main();
