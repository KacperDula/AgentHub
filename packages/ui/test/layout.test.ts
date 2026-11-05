import { describe, expect, it } from "vitest";
import { buildDemoScript, buildTree, createMemoryStore, parseLines, stampDemo } from "@agenttrace/core";
import { CARD_H, CARD_W, layoutCards } from "../src/layout";

describe("layout", () => {
  it("places the demo tree top-down without overlapping cards", () => {
    const store = createMemoryStore();
    store.apply(parseLines(stampDemo(buildDemoScript("l"), Date.parse("2026-11-04T12:00:00Z")), store.ctx));
    const events = store.events();
    const model = buildTree(events, store.todos(), events.at(-1)!.created_at);
    const pos = layoutCards(model.cards);
    const byId = new Map(model.cards.map((c) => [c.id, c]));
    for (const c of model.cards) if (c.parentId) expect(pos.get(c.id)!.y).toBeGreaterThan(pos.get(c.parentId)!.y);
    const boxes = model.cards.map((c) => ({ ...pos.get(c.id)!, h: CARD_H[byId.get(c.id)!.kind] }));
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        const overlap = a.x < b.x + CARD_W && b.x < a.x + CARD_W && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
  });
});
