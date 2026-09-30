function isWordBoundaryAt(text: string, pos: number): boolean {
  if (pos === 0) return true;
  const prev = text[pos - 1];
  const curr = text[pos];
  // Space, punctuation, or camelCase transition
  if (/\W/.test(prev)) return true;
  if (/[a-z]/.test(prev) && /[A-Z]/.test(curr)) return true;
  return false;
}

function isWordEndAt(text: string, pos: number): boolean {
  if (pos >= text.length) return true;
  const curr = text[pos];
  if (/\W/.test(curr)) return true;
  // camelCase: lowercase followed by uppercase
  if (pos > 0 && /[a-z]/.test(text[pos - 1]) && /[A-Z]/.test(curr)) return true;
  return false;
}

export function highlightTerms(
  text: string,
  terms: string[],
  boldOn: string,
  boldOff: string,
  wordBoundaryOnly = false,
): string {
  if (!terms.length || !text) return text;

  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();

  const matches: Array<{ start: number; end: number }> = [];
  for (const term of sorted) {
    const lt = term.toLowerCase();
    let pos = 0;
    while ((pos = lower.indexOf(lt, pos)) !== -1) {
      const end = pos + lt.length;

      if (wordBoundaryOnly) {
        const startOk = isWordBoundaryAt(text, pos);
        // Short terms (<=4 chars): require end boundary too (prevents "date" in "update")
        const endOk = lt.length > 4 || isWordEndAt(text, end);
        if (!startOk || !endOk) {
          pos++;
          continue;
        }
      }

      const overlaps = matches.some(m => pos < m.end && end > m.start);
      if (!overlaps) {
        matches.push({ start: pos, end });
      }
      pos++;
    }
  }

  if (!matches.length) return text;

  matches.sort((a, b) => a.start - b.start);

  let result = "";
  let cursor = 0;
  for (const m of matches) {
    result += text.slice(cursor, m.start);
    result += boldOn + text.slice(m.start, m.end) + boldOff;
    cursor = m.end;
  }
  result += text.slice(cursor);
  return result;
}

export function findExcerpts(
  terms: string[],
  fields: Array<{ text: string; label?: string }>,
  maxExcerpts = 5,
  maxChars = 120,
): Array<{ excerpt: string; label?: string }> {
  const results: Array<{ excerpt: string; label?: string; score: number }> = [];

  for (const field of fields) {
    if (!field.text) continue;
    const lower = field.text.toLowerCase();

    const positions: Array<{ pos: number; len: number }> = [];
    for (const term of terms) {
      const lt = term.toLowerCase();
      let pos = 0;
      while ((pos = lower.indexOf(lt, pos)) !== -1) {
        const beforeOk = pos === 0 || /\W/.test(lower[pos - 1]);
        const afterOk = lt.length > 3 || (pos + lt.length >= lower.length) || /\W/.test(lower[pos + lt.length]);
        if (beforeOk && afterOk) {
          positions.push({ pos, len: lt.length });
        }
        pos++;
      }
    }
    if (!positions.length) continue;
    positions.sort((a, b) => a.pos - b.pos);

    const usedRanges: Array<{ start: number; end: number }> = [];

    for (let attempt = 0; attempt < maxExcerpts && positions.length > 0; attempt++) {
      let bestIdx = 0;
      let bestCount = 0;
      for (let i = 0; i < positions.length; i++) {
        const windowEnd = positions[i].pos + maxChars;
        let count = 0;
        for (let j = i; j < positions.length && positions[j].pos < windowEnd; j++) {
          count++;
        }
        if (count > bestCount) {
          bestCount = count;
          bestIdx = i;
        }
      }

      const bestStart = positions[bestIdx].pos;
      let start = Math.max(0, bestStart - 20);
      let end = Math.min(field.text.length, start + maxChars);

      if (usedRanges.some(r => start < r.end && end > r.start)) break;

      if (start > 0) {
        const spaceLeft = field.text.lastIndexOf(" ", start);
        if (spaceLeft !== -1 && start - spaceLeft < 20) start = spaceLeft + 1;
      }
      if (end < field.text.length) {
        const spaceRight = field.text.indexOf(" ", end);
        if (spaceRight !== -1 && spaceRight - end < 20) end = spaceRight;
      }

      usedRanges.push({ start, end });

      let excerpt = field.text.slice(start, end).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
      if (start > 0) excerpt = "… " + excerpt;
      if (end < field.text.length) excerpt = excerpt + " …";

      results.push({ excerpt, label: field.label, score: bestCount });

      const windowStart = start;
      const windowEnd = end;
      for (let i = positions.length - 1; i >= 0; i--) {
        if (positions[i].pos >= windowStart && positions[i].pos < windowEnd) {
          positions.splice(i, 1);
        }
      }
      if (positions.length === 0) break;
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxExcerpts)
    .map(({ excerpt, label }) => ({ excerpt, label }));
}
