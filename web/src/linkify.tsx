import type { ReactNode } from "react";

const URL_RE = /https?:\/\/[^\s<>]+/gi;
const TRAIL = /[.,;:)]+$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function cleanUrl(raw: string): string {
  return raw.replace(TRAIL, "");
}

export function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = new RegExp(URL_RE.source, "gi");
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    const href = cleanUrl(match[0]);
    const start = match.index;
    const end = start + href.length;
    if (start > last) {
      nodes.push(text.slice(last, start));
    }
    nodes.push(
      <a key={`u-${i++}`} href={href} target="_blank" rel="noopener noreferrer">
        {href}
      </a>,
    );
    last = end;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes.length ? nodes : [text];
}

export function formatRichText(text: string): ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    if (BULLET.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(BULLET);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`}>
          {items.map((item, j) => (
            <li key={j}>{linkify(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (NUMBERED.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(NUMBERED);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`}>
          {items.map((item, j) => (
            <li key={j}>{linkify(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    const chunk: string[] = [];
    while (i < lines.length && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
      chunk.push(lines[i]);
      i += 1;
    }
    const body = chunk.join("\n");
    if (!body.trim()) continue;
    blocks.push(<p key={`p-${key++}`}>{linkify(body)}</p>);
  }
  return blocks.length ? blocks : null;
}
