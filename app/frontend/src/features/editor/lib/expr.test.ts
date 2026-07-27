import { describe, expect, it } from "vitest";

import { evalNumberExpression } from "./expr";

describe("evalNumberExpression", () => {
  it("parses plain numbers, signs, and decimals", () => {
    expect(evalNumberExpression("42")).toBe(42);
    expect(evalNumberExpression(" 3.5 ")).toBe(3.5);
    expect(evalNumberExpression("-7")).toBe(-7);
    expect(evalNumberExpression("+8")).toBe(8);
    expect(evalNumberExpression(".5")).toBe(0.5);
    expect(evalNumberExpression("5.")).toBe(5);
  });

  it("evaluates the four operators with precedence and parentheses", () => {
    expect(evalNumberExpression("100/2")).toBe(50);
    expect(evalNumberExpression("50+10")).toBe(60);
    expect(evalNumberExpression("8*3")).toBe(24);
    expect(evalNumberExpression("20-5")).toBe(15);
    expect(evalNumberExpression("2+3*4")).toBe(14);
    expect(evalNumberExpression("(2+3)*4")).toBe(20);
    expect(evalNumberExpression("-(3+4)")).toBe(-7);
    expect(evalNumberExpression("  6 / 2 ")).toBe(3);
  });

  it("rejects invalid, partial, or non-arithmetic input", () => {
    expect(evalNumberExpression("")).toBeNull();
    expect(evalNumberExpression("   ")).toBeNull();
    expect(evalNumberExpression("abc")).toBeNull();
    expect(evalNumberExpression("12px")).toBeNull();
    expect(evalNumberExpression("1.2.3")).toBeNull();
    expect(evalNumberExpression("2+")).toBeNull();
    expect(evalNumberExpression("()")).toBeNull();
    expect(evalNumberExpression(".")).toBeNull();
    expect(evalNumberExpression("alert(1)")).toBeNull();
  });

  it("rejects divide-by-zero (non-finite result)", () => {
    expect(evalNumberExpression("5/0")).toBeNull();
    expect(evalNumberExpression("1/(2-2)")).toBeNull();
  });
});
