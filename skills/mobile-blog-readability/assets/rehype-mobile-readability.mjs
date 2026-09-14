/** 한국어 문장 여백 표시기. 원고와 인라인 링크·강조는 보존한다. */
export function sentenceRanges(text) {
  const protectedRanges = [...text.matchAll(/https?:\/\/[^\s]+|\b10\.\d{4,9}\/[^\s]+|\b\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?/g)]
    .map((m) => [m.index, m.index + m[0].length]);
  const cuts = [0];
  // 한국어 종결 뒤만 후보로 삼고 인용번호·닫는 부호를 문장 쪽에 붙인다.
  // 숫자와 영문 약어 내부 마침표는 후보가 아니다.
  const endings = /[가-힣0-9%)\]][.!?](?:(?:\s*\[\d+(?:[,–—\-\s]+\d+)*\])|[”’"'」』)\]])*\s+/g;
  for (const m of text.matchAll(endings)) {
    const end = m.index + m[0].length;
    // 줄 맨 앞의 5. 같은 목록 번호는 문장이 아니다.
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (/^\s*\d+$/.test(text.slice(lineStart, m.index + 1))) continue;
    if (end >= text.length || protectedRanges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    // 인용을 받는 조사/서술을 별도 문장으로 만들지 않는다.
    if (/^(?:라고|이라고|라는|이라는|라며|이라며|고\s|하며|하고)/.test(text.slice(end))) continue;
    cuts.push(end);
  }
  return cuts.map((start, i) => [start, cuts[i + 1] ?? text.length]);
}

export function splitKoreanSentences(text) {
  return sentenceRanges(text).map(([start, end]) => text.slice(start, end).trim()).filter(Boolean);
}

const textOf = (node) => node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join('');

function inlineSlice(node, start, end, state) {
  const length = textOf(node).length;
  const offset = state.offset;
  state.offset += length;
  if (offset >= end || offset + length <= start) return null;
  if (node.type === 'text') return { ...node, value: node.value.slice(Math.max(0, start - offset), Math.min(length, end - offset)) };
  const childState = { offset };
  const children = (node.children ?? []).map((child) => inlineSlice(child, start, end, childState)).filter(Boolean);
  return { ...node, children };
}

function splitParagraph(node) {
  // 줄바꿈·이미지·코드·각주처럼 별도 의미를 가진 요소는 자동 절단하지 않는다.
  let unsupported = false;
  const links = [];
  let cursor = 0;
  const inspect = (item) => {
    if (item.type === 'text') { cursor += item.value.length; return; }
    if (item.type !== 'element' || !['p', 'a', 'strong', 'em', 'span', 'sup', 'sub', 'del', 'code'].includes(item.tagName)) unsupported = true;
    const start = cursor;
    for (const child of item.children ?? []) inspect(child);
    if (['a', 'code'].includes(item.tagName)) links.push([start, cursor]);
  };
  inspect(node);
  if (unsupported) return [node];
  const text = textOf(node);
  const ends = sentenceRanges(text).map((r) => r[1]);
  const citationTail = (end) => {
    const tailLinks = links.filter(([a]) => a >= end);
    if (!tailLinks.length) return false;
    let remaining = ''; let offset = end;
    for (const [a, b] of tailLinks) { remaining += text.slice(offset, a); offset = b; }
    remaining += text.slice(offset);
    return /^[\s.,·;()[\]{}]*$/.test(remaining);
  };
  const nominalLabel = (start, end) => {
    const part = inlineSlice(node, start, end, {offset: 0});
    const children = (part?.children ?? []).filter(c => c.type !== 'text' || c.value.trim());
    const label = textOf(part ?? {}).trim();
    return children.length === 1 && children[0].tagName === 'strong' && /\.$/.test(label) && !/(?:다|요|죠)\.$/.test(label);
  };
  const accepted = ends.filter((end, index) => !nominalLabel(ends[index - 1] ?? 0, end) && !citationTail(end) && !links.some(([a, b]) =>
    (end > a && end < b) || (a === end && !text.slice(b).trim())
  ));
  const hasLabel = nominalLabel(0, ends[0]);
  if (accepted.length < 2) return [hasLabel ? {...node, properties: {...node.properties, 'data-mobile-nominal-label': ''}} : node];
  let start = 0;
  const parts = accepted.map((end) => {
    const isLabelPart = start === 0 && hasLabel;
    const state = { offset: 0 };
    const children = node.children.map((child) => inlineSlice(child, start, end, state)).filter(Boolean);
    start = end;
    return { ...node, properties: { ...node.properties, 'data-mobile-sentence': '', ...(isLabelPart ? {'data-mobile-nominal-label': ''} : {}) }, children };
  });
  // 여러 문장의 직접 인용은 한 문단 안에서 빈 줄을 만들어 인용 범위를 유지한다.
  const quotes = [...text.matchAll(/[“「『][\s\S]*?[”」』]|"[^"\n]+"/g)];
  if (accepted.some((end) => quotes.some((q) => end > q.index && end < q.index + q[0].length))) {
    return [{ ...node, properties: { ...node.properties, 'data-mobile-inline-sentences': '' },
      children: parts.flatMap((part, index) => [...(index ? [
        { type: 'element', tagName: 'br', properties: {}, children: [] },
        { type: 'element', tagName: 'br', properties: {}, children: [] },
      ] : []), ...part.children]) }];
  }
  return parts;
}

function enumerateCommaParagraph(node, options = {}) {
  const text = textOf(node);
  const commaRule = (options.commaLists ?? []).find(rule => text.includes(rule.when));
  if (commaRule) {
    const start = text.indexOf(commaRule.from);
    const last = text.indexOf(commaRule.to, start);
    if (start < 0 || last < start) throw new Error(`확인된 쉼표 목록 경계를 찾지 못했습니다: ${commaRule.when}`);
    const end = last + commaRule.to.length;
    const ranges = []; let depth = 0; let cursor = start;
    for (let i = start; i < end; i++) {
      if ('([{'.includes(text[i])) depth++;
      else if (')]}'.includes(text[i])) depth--;
      else if (text[i] === ',' && depth === 0) { ranges.push([cursor, i + 1]); cursor = i + 1; }
      if (depth < 0) throw new Error('쉼표 목록의 괄호가 맞지 않습니다');
    }
    ranges.push([cursor, end]);
    if (depth !== 0 || ranges.length !== commaRule.count) throw new Error(`확인된 쉼표 목록 항목 수가 다릅니다: ${commaRule.when}`);
    const slice = (a, b) => inlineSlice(node, a, b, {offset: 0});
    // 원문의 쉼표·그리고·종결어미까지 보존하고 표시 구조만 바꾼다.
    return [...(text.slice(0, start).trim() ? [slice(0, start)] : []), {type:'element',tagName:'ul',properties:{className:['mobile-enumeration'],'data-mobile-comma-list':''},children:ranges.map(([a,b])=>({type:'element',tagName:'li',properties:{},children:[slice(a,b)]}))}, ...(text.slice(end).trim() ? [slice(end,text.length)] : [])];
  }
  return null;
}

function enumerateParagraph(node, options = {}) {
  const text = textOf(node);
  // Markdown이 문단으로 남긴 연속 번호 줄을 실제 목록으로 복원한다.
  const numeric = [...text.matchAll(/(?:^|\n)[ \t]*(\d+)\.[ \t]+/g)];
  if (numeric.length >= 2 && numeric.every((m, i) => i === 0 || +m[1] === +numeric[i - 1][1] + 1)) {
    const slice = (start, end) => { const state = {offset: 0}; return {...node, children: node.children.map(c => inlineSlice(c, start, end, state)).filter(Boolean)}; };
    return [...(numeric[0].index ? [slice(0,numeric[0].index)] : []), {type:'element',tagName:'ol',properties:{className:['mobile-enumeration'],start:+numeric[0][1]},children:numeric.map((m,i)=>({type:'element',tagName:'li',properties:{},children:[slice(m.index+m[0].length,numeric[i+1]?.index??text.length)]}))}];
  }
  const matches = [...text.matchAll(/(?:^|\s)(첫째|둘째|셋째|넷째|다섯째|여섯째),\s*/g)];
  if (matches.length < 2 || matches[0][1] !== '첫째' || matches[1][1] !== '둘째') return null;
  const slice = (start, end) => {
    const state = { offset: 0 };
    return { ...node, children: node.children.map((child) => inlineSlice(child, start, end, state)).filter(Boolean) };
  };
  const prefix = matches[0].index > 0 ? [slice(0, matches[0].index)] : [];
  const normalizeQuotes = value => value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const tailStart = Math.min(text.length, ...(options.enumerationEndBefore ?? []).map(entry => {
    const rule = typeof entry === 'string' ? {before: entry} : entry;
    if (rule.when && !normalizeQuotes(text).includes(normalizeQuotes(rule.when))) return -1;
    const index = normalizeQuotes(text).indexOf(normalizeQuotes(rule.before), matches.at(-1).index);
    if (rule.when && index < 0) throw new Error(`확인된 목록 요약 경계를 찾지 못했습니다: ${rule.when}`);
    return index;
  }).filter(i => i >= 0));
  const items = matches.map((m, index) => ({ type: 'element', tagName: 'li', properties: {}, children: [
    slice(m.index + m[0].length, matches[index + 1]?.index ?? tailStart),
  ] }));
  const ordered = (options.orderedEnumerationWhen ?? []).some(when => text.includes(when));
  return [...prefix, { type: 'element', tagName: ordered ? 'ol' : 'ul', properties: { className: ['mobile-enumeration'] }, children: items }, ...(tailStart < text.length ? [slice(tailStart,text.length)] : [])];
}

export function appliesToArticle(slug, pubDate, scope) {
  if (!scope) return true;
  const id = String(slug ?? '').split('/').at(-1).replace(/\.mdx?$/, '');
  if ((scope.slugs ?? []).includes(id)) return true;
  const date = pubDate ? new Date(pubDate) : null;
  return Boolean(date && !Number.isNaN(date.valueOf()) && scope.since && date >= new Date(scope.since));
}

// 요약도 본문과 같은 겹괄호 보호와 한국어 조사 보정을 재사용한다.
export function explainKoreanAbbreviations(value, glossary) {
  const tree = {type:'root',children:[{type:'element',tagName:'p',properties:{},children:[{type:'text',value}]}]};
  rehypeMobileReadability({glossary, glossaryOnly:true})(tree);
  return textOf(tree);
}

export default function rehypeMobileReadability(options = {}) {
  return (tree, file) => {
    if (options.scope && !appliesToArticle(file?.path, file?.data?.astro?.frontmatter?.pubDate, options.scope)) return;
    const definitionSeen = new Set();
    const containsTable = node => node.tagName === 'table' || (node.children ?? []).some(containsTable);
    tree.children = (tree.children ?? []).flatMap(node => {
      if (['h1','h2','h3','h4','pre','code'].includes(node.tagName)) return [node];
      const raw = textOf(node); const notes = [];
      for (const [abbr, full] of Object.entries(options.glossary ?? {})) {
        const pattern = new RegExp('(?<![A-Za-z0-9])' + abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])');
        if (definitionSeen.has(abbr) || !pattern.test(raw)) continue;
        definitionSeen.add(abbr);
        if (containsTable(node)) notes.push({type:'element',tagName:'p',properties:{'data-mobile-definition':abbr},children:[{type:'text',value:`용어: ${full}`}]});
      }
      return [node, ...notes];
    });
    const expanded = new Set();
    const depthAfter = (value, initial) => [...value].reduce((n,c)=>c==='('?n+1:c===')'?Math.max(0,n-1):n,initial);
    const prepare = (node, excluded = false, inheritedDepth = {value:0}) => {
      const depthState = ['p','li'].includes(node.tagName) ? {value:0} : inheritedDepth;
      const skip = excluded || ['a', 'pre', 'code', 'table', 'h1', 'h2', 'h3', 'h4'].includes(node.tagName);
      if (!node.children || skip) { depthState.value=depthAfter(textOf(node),depthState.value); return; }
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text') { prepare(child, skip, depthState); return [child]; }
        let value = child.value;
        for (const [abbr, full] of Object.entries(options.glossary ?? {})) {
          const plainFull = full.replace(/\(([^()]*)\)$/, ' $1');
          if (value.includes(full) || value.includes(plainFull)) expanded.add(abbr);
          const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp('(?<![A-Za-z0-9])' + escaped + '(?![A-Za-z0-9])');
          const match = value.match(pattern);
          if (!expanded.has(abbr) && match) {
            const before = value.slice(0, match.index);
            const depth = depthAfter(before, depthState.value);
            const display = depth > 0 ? plainFull : full;
            const after = value.slice(match.index + abbr.length);
            const particle = after.match(/^(으로|로|은|는|이|가|을|를|와|과)(?=\s|[.,!?;:)\]”’]|$)/)?.[0] ?? '';
            let corrected = particle;
            // 한국어 풀이의 끝말에 맞춰 조사만 보정한다(예: 시스템(ISG)이).
            const korean = full.replace(/\([^)]*\)$/, '').match(/[가-힣](?=[^가-힣]*$)/)?.[0];
            if (korean) {
              const jong = (korean.charCodeAt(0) - 0xac00) % 28;
              const batchim = jong !== 0;
              corrected = ({은: batchim ? '은' : '는', 는: batchim ? '은' : '는', 이: batchim ? '이' : '가', 가: batchim ? '이' : '가', 을: batchim ? '을' : '를', 를: batchim ? '을' : '를', 와: batchim ? '과' : '와', 과: batchim ? '과' : '와', 로: jong === 0 || jong === 8 ? '로' : '으로', 으로: jong === 0 || jong === 8 ? '로' : '으로'}[particle]) ?? particle;
            }
            value = before + display + corrected + after.slice(particle.length);
            expanded.add(abbr);
          }
        }
        depthState.value=depthAfter(child.value,depthState.value);
        const parts = []; let cursor = 0;
        // Markdown 파서가 한국어 조사 앞 강조를 문자로 남긴 경우만 복원한다.
        for (const match of value.matchAll(/\*\*([^*\n]+)\*\*/g)) {
          if (!(options.boldRepairs ?? []).includes(match[1])) continue;
          parts.push({ type: 'text', value: value.slice(cursor, match.index) });
          parts.push({ type: 'element', tagName: 'strong', properties: {}, children: [{ type: 'text', value: match[1] }] });
          cursor = match.index + match[0].length;
        }
        parts.push({ type: 'text', value: value.slice(cursor) });
        return parts.filter((p) => p.type !== 'text' || p.value);
      });
    };
    prepare(tree);
    if (options.glossaryOnly) return;
    const emphasize = node => {
      if (['a', 'table', 'pre', 'code', 'figure', 'figcaption'].includes(node.tagName)) return;
      const raw = textOf(node);
      if (node.tagName === 'p' && (options.emphasizeParagraphs ?? []).includes(raw.trim()) && node.children?.[0]?.tagName !== 'strong') {
        node.children = [{type:'element',tagName:'strong',properties:{},children:node.children}];
      }
      if (node.tagName === 'p' || (node.tagName === 'li' && node.children?.every(c=>c.type==='text'||['strong','em','a','span'].includes(c.tagName)))) {
        const prefix = (options.labelPrefixes ?? []).find(p=>raw.trimStart().startsWith(p));
        if (prefix && node.children?.find(c=>c.type!=='text'||c.value.trim())?.tagName !== 'strong') {
          const end = raw.length - raw.trimStart().length + prefix.length;
          const head = inlineSlice(node,0,end,{offset:0});
          const tail = inlineSlice(node,end,raw.length,{offset:0});
          node.children = [{type:'element',tagName:'strong',properties:{},children:head.children},...(tail?.children??[])];
        }
      }
      for (const child of node.children ?? []) emphasize(child);
    };
    emphasize(tree);
    // 출처 절의 서지 목록은 본문 확인 목록과 구분해 원래의 조밀한 형식을 유지한다.
    let bibliography = false;
    for (const node of tree.children ?? []) {
      if (/^h[23]$/.test(node.tagName ?? '')) bibliography = /^(출처|참고문헌|참고자료)$/.test(textOf(node).trim());
      if (bibliography && ['ul', 'ol'].includes(node.tagName)) node.properties = {...node.properties, className: [...(node.properties?.className ?? []), 'mobile-bibliography']};
    }
    // H3만으로 작성된 기존 글은 제목 문구·id를 보존해 H2로 올린다.
    const headings = (tree.children ?? []).filter((n) => /^h[23]$/.test(n.tagName ?? ''));
    if (headings.length && !headings.some((n) => n.tagName === 'h2')) {
      for (const heading of headings) heading.tagName = 'h2';
    }
    // 기존 글에서 명시적으로 나열한 첫째·둘째 문단과 지정한 항목 절만 목록으로 묶는다.
    const ordinal = /^(첫째|둘째|셋째|넷째|다섯째|여섯째),\s*/;
    // 도입 문장 뒤 첫째가 있고 둘째가 다음 문단이면 도입만 먼저 떼어 낸다.
    // 항목의 뒤 설명·예외는 쪼개지 않고 기존 문단 묶음에 그대로 넘긴다.
    tree.children = (tree.children ?? []).flatMap((node, index, siblings) => {
      if (node.tagName !== 'p') return [node];
      const raw = textOf(node);
      const markers = [...raw.matchAll(/(?:^|\s)(첫째|둘째|셋째|넷째|다섯째|여섯째),\s*/g)];
      const first = markers[0];
      const next = siblings.slice(index + 1).find(n => n.type !== 'text' || n.value.trim());
      if (markers.length !== 1 || first[1] !== '첫째' || first.index === 0 || next?.tagName !== 'p' || !/^둘째,\s*/.test(textOf(next))) return [node];
      const start = first.index + first[0].indexOf('첫째');
      const prefix = raw.slice(0, start).trim();
      if (!/[.!?][”’"')\]]*$/.test(prefix)) return [node];
      return [inlineSlice(node, 0, start, {offset: 0}), inlineSlice(node, start, raw.length, {offset: 0})];
    });
    let section = '';
    for (let i = 0; i < (tree.children ?? []).length; i++) {
      const node = tree.children[i];
      if (/^h[23]$/.test(node.tagName ?? '')) section = textOf(node);
      const numbered = node.tagName === 'p' && ordinal.test(textOf(node));
      const explicit = node.tagName === 'p' && (options.listSections ?? []).includes(section) && node.children?.[0]?.tagName === 'strong';
      if (!numbered && !explicit) continue;
      let end = i; const group = [];
      while (end < tree.children.length) {
        const next = tree.children[end];
        if (next.type === 'text' && !next.value.trim()) { end++; continue; }
        const matches = next.tagName === 'p' && (numbered ? ordinal.test(textOf(next)) : next.children?.[0]?.tagName === 'strong');
        if (!matches) break;
        group.push(next); end++;
      }
      if (group.length < 2) continue;
      for (const paragraph of group) {
        if (numbered && paragraph.children[0]?.type === 'text') paragraph.children[0].value = paragraph.children[0].value.replace(ordinal, '');
      }
      tree.children.splice(i, end - i, { type: 'element', tagName: 'ul', properties: { className: ['mobile-enumeration'] }, children: group.map((p) => ({ type: 'element', tagName: 'li', properties: {}, children: [p] })) });
    }
    const walk = (node, excluded = false, inQuote = false) => {
      inQuote = inQuote || node.tagName === 'blockquote';
      if (!node.children) return;
      const skip = excluded || ['table', 'pre', 'code', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4'].includes(node.tagName);
      node.children = node.children.flatMap((child) => {
        if (!skip && child.type === 'element' && child.tagName === 'p') {
          const enumerated = inQuote || /^\s*["“‘]/.test(textOf(child)) ? null : enumerateParagraph(child, options);
          if (enumerated) return enumerated.flatMap((part) => {
            if (part.tagName === 'p') return splitParagraph(part);
            walk(part, skip, inQuote); return [part];
          });
          return splitParagraph(child);
        }
        // tight 목록은 문장이 여러 개일 때만 같은 li 안에 문단으로 만든다.
        if (!skip && child.type === 'element' && child.tagName === 'li' && child.children?.every((c) => c.type === 'text' || ['a', 'strong', 'em', 'span'].includes(c.tagName))) {
          const parts = splitParagraph({ type: 'element', tagName: 'p', properties: {}, children: child.children });
          if (parts.length > 1 || parts[0].properties?.['data-mobile-inline-sentences'] !== undefined) return [{ ...child, children: parts }];
        }
        walk(child, skip, inQuote);
        return [child];
      });
    };
    walk(tree);
    // 문장과 서수 목록을 먼저 정리한 뒤 독립된 긴 나열 문장만 목록으로 바꾼다.
    const commaWalk = node => {
      if (!node.children || ['table','pre','code','figure','figcaption'].includes(node.tagName)) return;
      node.children = node.children.flatMap(child => {
        if (child.tagName === 'p') return enumerateCommaParagraph(child, options) ?? [child];
        commaWalk(child); return [child];
      });
    };
    commaWalk(tree);
    // 설명은 첫 등장 문장 바로 뒤에 둔다. 표 도입문과 표 사이는 떼지 않는다.
    const extraSeen = new Set();
    tree.children = (tree.children ?? []).flatMap(node => {
      if (['h1','h2','h3','h4','pre','code'].includes(node.tagName)) return [node];
      const raw = textOf(node); const notes = [];
      for (const [abbr, definition] of Object.entries(options.definitions ?? {})) {
        const escaped=abbr.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        if (extraSeen.has(abbr) || !new RegExp('(?<![A-Za-z0-9])'+escaped+'(?![A-Za-z0-9])').test(raw)) continue;
        extraSeen.add(abbr);
        notes.push({type:'element',tagName:'p',properties:{'data-mobile-definition':abbr},children:[{type:'text',value:definition}]});
      }
      return /^(?:아래|다음) 표/.test(raw.trim()) ? [...notes,node] : [node,...notes];
    });
    emphasize(tree);
  };
}
