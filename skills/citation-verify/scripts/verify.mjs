#!/usr/bin/env node
/**
 * Citation verifier for biomedical writing.
 * Resolves DOIs / PMIDs / PMCIDs against live registries and reports whether a
 * claimed citation actually exists, matches its claimed metadata, and is not retracted.
 *
 * Registries (all free, no API key):
 *   - NCBI E-utilities  (PubMed metadata + retraction status)
 *   - Crossref REST     (DOI resolution)
 *   - Europe PMC REST   (title search / reverse lookup)
 */

import { readFileSync } from 'node:fs';

const UA = 'citation-verify/1.0 (Claude Code skill; biomedical citation checking)';
const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const CROSSREF = 'https://api.crossref.org/works';
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, { retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 404) return { __notFound: true };
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * (i + 1));
        lastErr = new Error('HTTP ' + res.status);
        continue;
      }
      if (!res.ok) return { __httpError: res.status };
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  return { __netError: String((lastErr && lastErr.message) || lastErr) };
}

/* ---------- text normalisation & similarity ---------- */

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Sorensen-Dice on character bigrams: robust to word order and minor edits.
function dice(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(A), gb = grams(B);
  let hit = 0, na = 0, nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  for (const [g, c] of ga) hit += Math.min(c, gb.get(g) || 0);
  return (2 * hit) / (na + nb);
}

function surname(s) {
  const t = norm(s).split(' ').filter(Boolean);
  if (!t.length) return '';
  // "Mehra MR" -> mehra ; "M. R. Mehra" -> mehra ; "Mehra, Mandeep R" -> mehra
  const long = t.filter((w) => w.length > 2);
  return long[0] || t[0];
}

/* ---------- identifier extraction ---------- */

// Parentheses are legal inside a DOI - Elsevier/Lancet suffixes look like
// 10.1016/S0140-6736(20)31180-6 - so they must be matched, then rebalanced below.
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>,;]+/gi;
const PMID_RE = /\bPMID:?\s*(\d{4,8})\b/gi;
const PMCID_RE = /\bPMC(\d{5,9})\b/gi;

const count = (s, ch) => s.split(ch).length - 1;

function cleanDoi(d) {
  let s = String(d)
    .replace(/^(https?:\/\/(dx\.)?doi\.org\/)/i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
  // Strip trailing punctuation, and any bracket that closes one opened outside the DOI.
  for (let guard = 0; guard < 32; guard++) {
    if (/[.,;:]$/.test(s)) { s = s.slice(0, -1); continue; }
    if (s.endsWith(')') && count(s, ')') > count(s, '(')) { s = s.slice(0, -1); continue; }
    if (s.endsWith(']') && count(s, ']') > count(s, '[')) { s = s.slice(0, -1); continue; }
    if (s.endsWith('}') && count(s, '}') > count(s, '{')) { s = s.slice(0, -1); continue; }
    break;
  }
  return s;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(lt|gt|amp|quot|apos|nbsp);/gi, (_, e) => ENTITIES[e.toLowerCase()]);
}

function extractIds(text) {
  const dois = new Set(), pmids = new Set(), pmcids = new Set();
  for (const m of text.matchAll(DOI_RE)) dois.add(cleanDoi(m[0]).toLowerCase());
  for (const m of text.matchAll(PMID_RE)) pmids.add(m[1]);
  for (const m of text.matchAll(PMCID_RE)) pmcids.add('PMC' + m[1]);
  return { dois: [...dois], pmids: [...pmids], pmcids: [...pmcids] };
}

/* ---------- registry lookups ---------- */

function pubmedRecord(e) {
  const ids = Object.fromEntries((e.articleids || []).map((a) => [a.idtype, a.value]));
  const pubtypes = e.pubtype || [];
  return {
    source: 'pubmed',
    pmid: e.uid,
    doi: (ids.doi || '').toLowerCase() || null,
    pmcid: ids.pmc || null,
    title: decodeEntities(e.title || '').replace(/\.$/, ''),
    authors: (e.authors || []).map((a) => a.name),
    journal: e.fulljournalname || e.source || null,
    year: (String(e.pubdate || '').match(/\d{4}/) || [null])[0],
    pubtypes,
    retracted: pubtypes.some((p) => /^Retracted Publication$/i.test(p)),
    isRetractionNotice: pubtypes.some((p) => /^Retraction of Publication$/i.test(p)),
  };
}

async function lookupPmids(pmids) {
  const out = new Map();
  for (let i = 0; i < pmids.length; i += 180) {
    const batch = pmids.slice(i, i + 180);
    const j = await getJSON(NCBI + '/esummary.fcgi?db=pubmed&retmode=json&id=' + batch.join(','));
    if (j.__netError || j.__httpError) {
      for (const p of batch) out.set(p, { error: j.__netError || ('HTTP ' + j.__httpError) });
    } else {
      const r = (j && j.result) || {};
      for (const p of batch) {
        const e = r[p];
        if (!e || e.error) out.set(p, null);
        else out.set(p, pubmedRecord(e));
      }
    }
    if (i + 180 < pmids.length) await sleep(400);
  }
  return out;
}

async function lookupDoi(doi) {
  const j = await getJSON(CROSSREF + '/' + encodeURIComponent(doi));
  if (j.__notFound) return null;
  if (j.__netError || j.__httpError) return { error: j.__netError || ('HTTP ' + j.__httpError) };
  const m = j.message || {};
  const parts = (m.issued && m.issued['date-parts'] && m.issued['date-parts'][0]) || [];
  return {
    source: 'crossref',
    doi: (m.DOI || doi).toLowerCase(),
    title: decodeEntities((m.title && m.title[0]) || '').replace(/<[^>]+>/g, ''),
    authors: (m.author || []).map((a) => [a.family, a.given].filter(Boolean).join(' ')),
    journal: (m['container-title'] && m['container-title'][0]) || null,
    year: parts[0] ? String(parts[0]) : null,
    type: m.type || null,
    updateTo: (m['update-to'] || []).map((u) => u.type + ': ' + u.DOI),
  };
}

// In Europe PMC's `core` result the journal name sits under journalInfo.journal,
// not the top-level journalTitle that the lite result carries.
function epmcRecord(h) {
  const ji = h.journalInfo || {};
  return {
    source: 'europepmc',
    pmcid: h.pmcid || null,
    pmid: h.pmid || null,
    doi: (h.doi || '').toLowerCase() || null,
    title: decodeEntities(h.title || '').replace(/\.$/, ''),
    authors: String(h.authorString || '').replace(/\.$/, '').split(/,\s*/).filter(Boolean),
    journal: (ji.journal && (ji.journal.title || ji.journal.medlineAbbreviation)) || h.journalTitle || null,
    year: h.pubYear || ji.yearOfPublication || null,
  };
}

async function lookupPmcid(pmcid) {
  const j = await getJSON(EPMC + '/search?query=' + encodeURIComponent('PMCID:' + pmcid) + '&format=json&pageSize=1&resultType=core');
  if (j.__netError || j.__httpError) return { error: j.__netError || ('HTTP ' + j.__httpError) };
  const hit = j.resultList && j.resultList.result && j.resultList.result[0];
  if (!hit) return null;
  const rec = epmcRecord(hit);
  rec.pmcid = rec.pmcid || pmcid;
  return rec;
}

async function searchQuery(q, limit = 5) {
  const j = await getJSON(EPMC + '/search?query=' + encodeURIComponent(q) + '&format=json&pageSize=' + limit + '&resultType=core');
  if (j.__netError || j.__httpError) return [];
  const rows = (j.resultList && j.resultList.result) || [];
  return rows.map(epmcRecord);
}

/**
 * Crossref carries no retraction flag, so a DOI-only citation would slip past the
 * retraction check. Map the DOI to its PMID via Europe PMC and pull PubMed's
 * publication types, which do record retractions.
 */
async function enrichDoiWithPubmed(rec) {
  const hits = await searchQuery('DOI:"' + rec.doi + '"', 1);
  if (hits[0] && hits[0].pmid) {
    const pm = (await lookupPmids([hits[0].pmid])).get(hits[0].pmid);
    if (pm && !pm.error) {
      rec.retracted = pm.retracted;
      rec.isRetractionNotice = pm.isRetractionNotice;
      rec.pmid = pm.pmid;
      if (!rec.pmcid && pm.pmcid) rec.pmcid = pm.pmcid;
    }
  }
  return rec;
}

/* ---------- verdicts ---------- */

const TITLE_MATCH = 0.72;
const TITLE_WEAK = 0.45;

function judge(rec, claim) {
  const notes = [];
  let verdict = 'OK';

  if (rec.retracted) {
    notes.push('PubMed publication type includes "Retracted Publication" - this paper has been RETRACTED. Do not cite it as valid evidence.');
    verdict = 'RETRACTED';
  }
  if (rec.isRetractionNotice) notes.push('This record is a retraction notice, not a research article.');
  if (rec.updateTo && rec.updateTo.length) notes.push('Crossref update-to: ' + rec.updateTo.join('; '));

  if (claim.title) {
    const sim = dice(claim.title, rec.title);
    notes.push('title similarity ' + sim.toFixed(2));
    if (sim < TITLE_WEAK) {
      notes.push('CLAIMED TITLE DOES NOT MATCH the record. Claimed: "' + claim.title + '" | Actual: "' + rec.title + '"');
      if (verdict !== 'RETRACTED') verdict = 'MISMATCH';
    } else if (sim < TITLE_MATCH) {
      notes.push('title only partially matches. Claimed: "' + claim.title + '" | Actual: "' + rec.title + '"');
      if (verdict === 'OK') verdict = 'SUSPECT';
    }
  }

  if (claim.author && rec.authors && rec.authors.length) {
    const want = surname(claim.author);
    const got = rec.authors.map(surname);
    if (want && !got.includes(want)) {
      notes.push('claimed author "' + claim.author + '" not among record authors (' + rec.authors.slice(0, 3).join('; ') + (rec.authors.length > 3 ? '; et al.' : '') + ')');
      if (verdict === 'OK') verdict = 'SUSPECT';
    }
  }

  if (claim.year && rec.year) {
    const d = Math.abs(Number(claim.year) - Number(rec.year));
    if (d > 1) {
      notes.push('claimed year ' + claim.year + ' but record says ' + rec.year);
      if (verdict === 'OK') verdict = 'SUSPECT';
    } else if (d === 1) {
      notes.push('year off by one (claimed ' + claim.year + ', record ' + rec.year + ') - common for online-first vs print');
    }
  }

  if (claim.journal && rec.journal && dice(claim.journal, rec.journal) < 0.5) {
    notes.push('claimed journal "' + claim.journal + '" but record says "' + rec.journal + '"');
    if (verdict === 'OK') verdict = 'SUSPECT';
  }

  return { verdict, notes };
}

function fmt(rec) {
  if (!rec) return '';
  const a = rec.authors || [];
  const who = a.length ? a.slice(0, 3).join('; ') + (a.length > 3 ? '; et al.' : '') : '(no authors listed)';
  const idbits = [rec.pmid && ('PMID ' + rec.pmid), rec.doi && ('DOI ' + rec.doi), rec.pmcid].filter(Boolean);
  return [
    '      title   : ' + (rec.title || '(none)'),
    '      authors : ' + who,
    '      journal : ' + (rec.journal || '(unknown)') + ' (' + (rec.year || '?') + ')',
    '      ids     : ' + (idbits.join(' | ') || '(none)'),
  ].join('\n');
}

/* ---------- commands ---------- */

async function cmdVerify(opts) {
  const results = [];
  const claim = { title: opts.title, author: opts.author, year: opts.year, journal: opts.journal };

  if (opts.pmid) {
    const rec = (await lookupPmids([opts.pmid])).get(opts.pmid);
    if (rec && rec.error) results.push({ id: 'PMID ' + opts.pmid, verdict: 'ERROR', notes: [rec.error] });
    else if (!rec) results.push({ id: 'PMID ' + opts.pmid, verdict: 'NOT_FOUND', notes: ['No PubMed record with this PMID. The identifier does not exist.'] });
    else results.push({ id: 'PMID ' + opts.pmid, rec, ...judge(rec, claim) });
  }
  if (opts.doi) {
    const rec = await lookupDoi(opts.doi);
    if (rec && rec.error) results.push({ id: 'DOI ' + opts.doi, verdict: 'ERROR', notes: [rec.error] });
    else if (!rec) results.push({ id: 'DOI ' + opts.doi, verdict: 'NOT_FOUND', notes: ['Crossref has no record for this DOI. The identifier does not exist.'] });
    else {
      await enrichDoiWithPubmed(rec);
      results.push({ id: 'DOI ' + opts.doi, rec, ...judge(rec, claim) });
    }
  }
  if (opts.pmcid) {
    const rec = await lookupPmcid(opts.pmcid);
    if (rec && rec.error) results.push({ id: opts.pmcid, verdict: 'ERROR', notes: [rec.error] });
    else if (!rec) results.push({ id: opts.pmcid, verdict: 'NOT_FOUND', notes: ['Europe PMC has no record for this PMCID.'] });
    else results.push({ id: opts.pmcid, rec, ...judge(rec, claim) });
  }

  // Title given but no identifier -> reverse lookup.
  if (!opts.pmid && !opts.doi && !opts.pmcid && opts.title) {
    const hits = await searchQuery('TITLE:"' + opts.title + '"', 5);
    if (!hits.length) {
      results.push({ id: '"' + opts.title + '"', verdict: 'NOT_FOUND', notes: ['No Europe PMC record matches this title. The citation may be fabricated.'] });
    } else {
      const best = hits[0];
      const sim = dice(opts.title, best.title);
      results.push({
        id: '"' + opts.title + '"',
        rec: best,
        verdict: sim >= TITLE_MATCH ? 'OK' : sim >= TITLE_WEAK ? 'SUSPECT' : 'NOT_FOUND',
        notes: ['best match similarity ' + sim.toFixed(2)].concat(sim < TITLE_MATCH ? ['No confident title match found - treat as unverified.'] : []),
      });
    }
  }
  return results;
}

async function cmdCheck(files) {
  let text = '';
  for (const f of files) text += '\n' + readFileSync(f, 'utf8');
  const { dois, pmids, pmcids } = extractIds(text);
  const results = [];
  // DOIs already resolved through a PMID in this same document: reuse that PubMed
  // record's retraction status instead of paying for another round trip.
  const doiToPubmed = new Map();

  if (pmids.length) {
    const m = await lookupPmids(pmids);
    for (const p of pmids) {
      const rec = m.get(p);
      if (rec && rec.error) results.push({ id: 'PMID ' + p, verdict: 'ERROR', notes: [rec.error] });
      else if (!rec) results.push({ id: 'PMID ' + p, verdict: 'NOT_FOUND', notes: ['No PubMed record with this PMID.'] });
      else {
        if (rec.doi) doiToPubmed.set(rec.doi, rec);
        results.push({ id: 'PMID ' + p, rec, ...judge(rec, {}) });
      }
    }
  }
  for (const d of dois) {
    const rec = await lookupDoi(d);
    if (rec && rec.error) results.push({ id: 'DOI ' + d, verdict: 'ERROR', notes: [rec.error] });
    else if (!rec) results.push({ id: 'DOI ' + d, verdict: 'NOT_FOUND', notes: ['Crossref has no record for this DOI.'] });
    else {
      // A DOI-only citation still has to be screened for retraction.
      const known = doiToPubmed.get(rec.doi);
      if (known) {
        rec.retracted = known.retracted;
        rec.isRetractionNotice = known.isRetractionNotice;
        rec.pmid = known.pmid;
        if (!rec.pmcid && known.pmcid) rec.pmcid = known.pmcid;
      } else {
        await enrichDoiWithPubmed(rec);
      }
      results.push({ id: 'DOI ' + d, rec, ...judge(rec, {}) });
    }
    await sleep(150);
  }
  for (const c of pmcids) {
    const rec = await lookupPmcid(c);
    if (rec && rec.error) results.push({ id: c, verdict: 'ERROR', notes: [rec.error] });
    else if (!rec) results.push({ id: c, verdict: 'NOT_FOUND', notes: ['Europe PMC has no record for this PMCID.'] });
    else results.push({ id: c, rec, ...judge(rec, {}) });
    await sleep(150);
  }
  return results;
}

/* ---------- cli ---------- */

const HELP = [
  'citation-verify - resolve and validate biomedical citations',
  '',
  '  verify [--pmid N] [--doi D] [--pmcid PMCn] [--title T] [--author A] [--year Y] [--journal J]',
  '      Resolve one citation. Any claimed metadata given is compared against the live record.',
  '',
  '  check <file...>',
  '      Extract every DOI / PMID / PMCID from the file(s) and verify each one.',
  '',
  '  search "<query>" [--limit N]',
  '      Find the real citation for a paper (Europe PMC). Use to REPLACE an unverified citation.',
  '',
  '  Options: --json   machine-readable output',
  '',
  'Verdicts: OK | SUSPECT | MISMATCH | NOT_FOUND | RETRACTED | ERROR',
  'Exit code 1 if any citation is NOT_FOUND, MISMATCH or RETRACTED.',
].join('\n');

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'json') o.json = true;
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const o = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return 0; }

  let results;
  if (cmd === 'verify') {
    if (o.doi) o.doi = cleanDoi(o.doi).toLowerCase();
    if (!o.pmid && !o.doi && !o.pmcid && !o.title) { console.error('verify needs at least one of --pmid --doi --pmcid --title'); return 2; }
    results = await cmdVerify(o);
  } else if (cmd === 'check') {
    if (!o._.length) { console.error('check needs at least one file'); return 2; }
    results = await cmdCheck(o._);
  } else if (cmd === 'search') {
    const hits = await searchQuery(o._.join(' '), Number(o.limit) || 5);
    if (o.json) { console.log(JSON.stringify(hits, null, 2)); return 0; }
    if (!hits.length) { console.log('No results.'); return 0; }
    hits.forEach((h, i) => console.log('\n[' + (i + 1) + ']\n' + fmt(h)));
    return 0;
  } else { console.error('unknown command "' + cmd + '"\n\n' + HELP); return 2; }

  if (o.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    if (!results.length) { console.log('No DOIs, PMIDs or PMCIDs found.'); return 0; }
    for (const r of results) {
      console.log('\n[' + r.verdict + '] ' + r.id);
      if (r.rec) console.log(fmt(r.rec));
      for (const n of r.notes || []) console.log('      - ' + n);
    }
    const ok = results.filter((r) => r.verdict === 'OK').length;
    const sus = results.filter((r) => r.verdict === 'SUSPECT').length;
    const bad = results.filter((r) => ['NOT_FOUND', 'MISMATCH', 'RETRACTED'].includes(r.verdict)).length;
    console.log('\n---\n' + results.length + ' checked | ' + ok + ' OK | ' + sus + ' suspect | ' + bad + ' failed');
  }
  return results.some((r) => ['NOT_FOUND', 'MISMATCH', 'RETRACTED'].includes(r.verdict)) ? 1 : 0;
}

// Close fetch's keep-alive sockets so the event loop drains and the process exits
// with the right code. Calling process.exit() with those handles still open trips a
// libuv assertion on Windows and clobbers the exit code.
async function shutdown() {
  const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (d && typeof d.close === 'function') { try { await d.close(); } catch { /* ignore */ } }
}

main()
  .then(async (c) => { process.exitCode = c; await shutdown(); })
  .catch(async (e) => { console.error('fatal:', e); process.exitCode = 3; await shutdown(); });
