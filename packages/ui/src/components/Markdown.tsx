import type { ReactNode } from "react";

/** Inline: **bold**, *italic*, `code`. Everything else is plain text (React escapes it). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(
      t.startsWith("**") ? (
        <b key={m.index}>{t.slice(2, -2)}</b>
      ) : t.startsWith("`") ? (
        <code key={m.index}>{t.slice(1, -1)}</code>
      ) : (
        <i key={m.index}>{t.slice(1, -1)}</i>
      ),
    );
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * A small, safe Markdown renderer for AI replies and notes: headings, bullet and numbered lists, code blocks,
 * paragraphs, bold and inline code. No HTML is ever injected.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    para = [];
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
      blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    }
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      blocks.push(
        <pre key={blocks.length} className="code">
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      blocks.push(
        level <= 2 ? <h4 key={blocks.length}>{inline(h[2])}</h4> : <h5 key={blocks.length}>{inline(h[2])}</h5>,
      );
    } else if (li) {
      if (para.length) flush();
      const ordered = /\d/.test(li[1]);
      if (list && list.ordered !== ordered) flush();
      (list ??= { ordered, items: [] }).items.push(li[2]);
    } else if (!line.trim()) flush();
    else if (list && /^\s{2,}\S/.test(line)) list.items[list.items.length - 1] += " " + line.trim();
    else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className="md">{blocks}</div>;
}
