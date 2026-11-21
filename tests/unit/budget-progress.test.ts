import { describe, expect, it } from "vitest";
import {
  budgetPercent,
  budgetState,
  countByState,
  sortByUrgency,
} from "#/lib/budget-progress";

const b = (name: string, spent: number, limit: number) => ({
  name,
  spent_minor: spent,
  limit_minor: limit,
  over: spent > limit,
});

describe("budget progress rules", () => {
  it("classifies under, near (from 80%) and over (above the limit)", () => {
    expect(budgetState(b("a", 79, 100))).toBe("under");
    expect(budgetState(b("a", 80, 100))).toBe("near");
    expect(budgetState(b("a", 100, 100))).toBe("near"); // at the limit is not over (D5)
    expect(budgetState(b("a", 101, 100))).toBe("over");
  });

  it("rounds the percentage, which can exceed 100", () => {
    expect(budgetPercent(b("a", 1, 3))).toBe(33);
    expect(budgetPercent(b("a", 28750, 25000))).toBe(115);
  });

  it("orders by urgency: over first, then by share of the limit used", () => {
    const sorted = sortByUrgency([
      b("transport", 220, 500), // 44%
      b("fruit", 900, 1000), // 90%
      b("fun", 288, 250), // over, 115%
      b("food", 367, 400), // 92%
      b("rent", 2600, 2500), // over, 104%
    ]);
    expect(sorted.map((x) => x.name)).toEqual([
      "fun",
      "rent",
      "food",
      "fruit",
      "transport",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [b("a", 1, 100), b("b", 200, 100)];
    sortByUrgency(input);
    expect(input.map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("counts budgets per state", () => {
    expect(
      countByState([b("a", 288, 250), b("b", 367, 400), b("c", 220, 500), b("d", 0, 10)]),
    ).toEqual({ over: 1, near: 1, under: 2 });
    expect(countByState([])).toEqual({ over: 0, near: 0, under: 0 });
  });
});
