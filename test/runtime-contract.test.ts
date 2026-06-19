import { describe, expect, it } from "vitest";
import {
  evalCondition,
  evaluateConditions,
  validateCommit,
} from "../src/runtime-contract.js";

describe("runtime contract", () => {
  describe("evalCondition", () => {
    it("compares state dotpaths with eq/lte/gte", () => {
      const state = { hp: 0, flags: { has_treasure: true }, nested: { count: 3 } };
      expect(evalCondition(state, { state: "hp", lte: 0 })).toBe(true);
      expect(evalCondition(state, { state: "hp", gt: 0 })).toBe(false);
      expect(evalCondition(state, { state: "nested.count", gte: 3 })).toBe(true);
      expect(evalCondition(state, { state: "nested.count", eq: 4 })).toBe(false);
    });

    it("reads flags from state.flags then top level", () => {
      const state = { flags: { fled: true }, frozen: true };
      expect(evalCondition(state, { flag: "fled", equals: true })).toBe(true);
      expect(evalCondition(state, { flag: "frozen" })).toBe(true); // truthiness, top-level fallback
      expect(evalCondition(state, { flag: "missing" })).toBe(false);
    });

    it("supports includes for arrays and strings", () => {
      const state = { inventory: ["rope", "lantern"], note: "the tide will not wait" };
      expect(evalCondition(state, { state: "inventory", includes: "rope" })).toBe(true);
      expect(evalCondition(state, { state: "note", includes: "tide" })).toBe(true);
      expect(evalCondition(state, { state: "inventory", includes: "sword" })).toBe(false);
    });

    it("composes with all/any", () => {
      const state = { hp: 2, flags: { slime_frozen: true } };
      expect(
        evalCondition(state, { all: [{ state: "hp", gt: 0 }, { flag: "slime_frozen", equals: true }] })
      ).toBe(true);
      expect(
        evalCondition(state, { any: [{ state: "hp", lte: 0 }, { flag: "slime_frozen", equals: true }] })
      ).toBe(true);
      expect(
        evalCondition(state, { all: [{ state: "hp", lte: 0 }, { flag: "slime_frozen" }] })
      ).toBe(false);
    });

    it("returns false for empty/missing clauses and never throws on missing fields", () => {
      expect(evalCondition({}, undefined)).toBe(false);
      expect(evalCondition({}, {})).toBe(false);
      expect(evalCondition({}, { state: "deep.path.nope", eq: 1 })).toBe(false);
    });
  });

  describe("evaluateConditions", () => {
    it("returns undefined when no conditions declared", () => {
      expect(evaluateConditions({ hp: 1 }, undefined)).toBeUndefined();
      expect(evaluateConditions({ hp: 1 }, {})).toBeUndefined();
      expect(evaluateConditions({ hp: 1 }, { conditions: {} })).toBeUndefined();
    });

    it("resolves lose over win and reports met flags", () => {
      const contract = {
        conditions: {
          win: [{ id: "treasure", label: "Win", when: { flag: "has_treasure", equals: true } }],
          lose: [{ id: "drowned", label: "Lose", when: { state: "hp", lte: 0 } }],
        },
      };
      const result = evaluateConditions({ hp: 0, flags: { has_treasure: true } }, contract)!;
      expect(result.resolved).toBe("lose");
      expect(result.resolved_id).toBe("drowned");
      expect(result.win[0].met).toBe(true);
      expect(result.lose[0].met).toBe(true);
    });

    it("resolved is null when nothing met", () => {
      const contract = { conditions: { win: [{ id: "w", when: { flag: "done", equals: true } }] } };
      const result = evaluateConditions({ flags: {} }, contract)!;
      expect(result.resolved).toBeNull();
    });
  });

  describe("validateCommit", () => {
    const contract = { required_state_fields: ["hp", "location"] };

    it("rejects dropping a previously-present required field", () => {
      const prev = { campaign_id: "c", turn: 1, schema: "s", hp: 5, location: "hall" };
      const next = { campaign_id: "c", turn: 2, schema: "s", location: "hall" }; // hp dropped
      const problems = validateCommit(prev, next, contract);
      expect(problems).toHaveLength(1);
      expect(problems[0].field).toBe("hp");
      expect(problems[0].code).toBe("required_field_dropped");
    });

    it("rejects dropping a core field", () => {
      const prev = { campaign_id: "c", turn: 1, schema: "s" };
      const next = { turn: 2, schema: "s" }; // campaign_id dropped
      const problems = validateCommit(prev, next, contract);
      expect(problems.map((p) => p.field)).toContain("campaign_id");
    });

    it("allows an optional declared field that was never set", () => {
      const prev = { campaign_id: "c", turn: 0, schema: "s" }; // no hp yet
      const next = { campaign_id: "c", turn: 1, schema: "s" };
      expect(validateCommit(prev, next, contract)).toHaveLength(0);
    });

    it("is a no-op without a contract", () => {
      const prev = { campaign_id: "c", turn: 1, schema: "s", hp: 5 };
      const next = { campaign_id: "c", turn: 2, schema: "s" };
      expect(validateCommit(prev, next, undefined)).toHaveLength(0);
    });
  });
});
