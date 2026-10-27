import { readFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';

export function headingIds(content) {
  const ids = new Set(), counts = new Map();
  let fence = null;
  for (const line of content.split(/\r?\n/)) {
    const marker = /^\s{0,3}(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (!heading) continue;
    const base = heading.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
      .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    let suffix = counts.get(base) ?? 0, id = suffix ? base + '-' + suffix : base;
    while (ids.has(id)) id = base + '-' + (++suffix);
    counts.set(base, suffix + 1); ids.add(id);
  }
  return ids;
}

export function checkMarkdown(file) {
  const content = readFileSync(file, 'utf8');
  let fence = null;
  const prose = content.split(/\r?\n/).filter(line => {
    const marker = /^\s{0,3}(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return false;
    }
    return !fence;
  }).join('\n');
  if (fence) throw new Error(`코드 블록 오류: ${file}`);
  for (const [, raw] of prose.matchAll(/\]\(([^)]+)\)/g)) {
    const link = raw.trim().replace(/^<(.+)>$/, '$1');
    if (/^(https?:|mailto:)/.test(link)) continue;
    const at = link.indexOf('#'), path = at < 0 ? link : link.slice(0, at);
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : resolve(file);
    const text = readFileSync(target, 'utf8');
    if (at >= 0 && extname(target).toLowerCase() === '.md') {
      const anchor = decodeURIComponent(link.slice(at + 1));
      if (anchor && !headingIds(text).has(anchor)) throw new Error(`문서 앵커 없음: ${file} → ${link}`);
    }
  }
}
