import { type ReactNode } from "react";

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL_ITEM = /^\s*[-*]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const INLINE = /(!?\[([^\]]*)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_)/;

function safeHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (
    /^https?:\/\//i.test(trimmed) ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("#")
  ) {
    return trimmed;
  }
  return undefined;
}

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const key = `${keyPrefix}-${i++}`;
    const whole = match[0];
    if (whole.startsWith("![")) {
      nodes.push(match[2] || "");
    } else if (whole.startsWith("[")) {
      const href = safeHref(match[3] || "");
      if (href) {
        const external = /^https?:\/\//i.test(href);
        nodes.push(
          <a
            key={key}
            href={href}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {match[2]}
          </a>,
        );
      } else {
        nodes.push(match[2] || whole);
      }
    } else if (whole.startsWith("**")) {
      nodes.push(<strong key={key}>{match[4]}</strong>);
    } else if (whole.startsWith("*") || whole.startsWith("_")) {
      nodes.push(<em key={key}>{match[5] || match[6]}</em>);
    } else {
      nodes.push(whole);
    }
    rest = rest.slice(match.index + whole.length);
  }
  return nodes;
}

export function renderChangelogMarkdown(source: string): ReactNode {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    if (!lines[i].trim()) {
      i += 1;
      continue;
    }

    const heading = HEADING.exec(lines[i]);
    if (heading) {
      const level = heading[1].length;
      const Tag = (level <= 2 ? "h2" : level === 3 ? "h3" : "h4") as "h2" | "h3" | "h4";
      blocks.push(
        <Tag key={`h-${key++}`}>{inlineMarkdown(heading[2], `h${key}`)}</Tag>,
      );
      i += 1;
      continue;
    }

    if (UL_ITEM.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i].match(UL_ITEM);
        if (!item) break;
        items.push(item[1]);
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`}>
          {items.map((item, j) => (
            <li key={j}>{inlineMarkdown(item, `ul${key}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (OL_ITEM.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i].match(OL_ITEM);
        if (!item) break;
        items.push(item[1]);
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`}>
          {items.map((item, j) => (
            <li key={j}>{inlineMarkdown(item, `ol${key}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const chunk: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING.test(lines[i]) &&
      !UL_ITEM.test(lines[i]) &&
      !OL_ITEM.test(lines[i])
    ) {
      chunk.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={`p-${key++}`}>{inlineMarkdown(chunk.join(" "), `p${key}`)}</p>,
    );
  }

  return blocks.length ? blocks : null;
}
