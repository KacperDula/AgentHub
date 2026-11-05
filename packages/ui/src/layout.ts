import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import type { CardKind } from "@agenttrace/core";

export const CARD_W = 280;
/** Fixed heights per card type keep the layout stable while content changes. */
export const CARD_H: Record<CardKind, number> = {
  group: 84,
  prompt: 136,
  agent: 156,
  subagent: 156,
  tool: 116,
  mcp: 116,
  resource: 100,
  fold: 84,
};

/** Top-down dagre layout; returns each card's top-left position. */
export function layoutCards(cards: { id: string; kind: CardKind; parentId: string | null }[]) {
  const g = new Graph();
  g.setGraph({ rankdir: "TB", ranksep: 58, nodesep: 34, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(cards.map((c) => c.id));
  for (const c of cards) g.setNode(c.id, { width: CARD_W, height: CARD_H[c.kind] });
  for (const c of cards) if (c.parentId && ids.has(c.parentId)) g.setEdge(c.parentId, c.id);
  dagreLayout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const c of cards) {
    const n = g.node(c.id);
    out.set(c.id, { x: n.x - CARD_W / 2, y: n.y - CARD_H[c.kind] / 2 });
  }
  return out;
}
