/**
 * Tiny, safe arithmetic evaluator for numeric input fields. Supports `+ - * /`,
 * parentheses, unary signs, and decimals — enough to type "100/2" or "(8+2)*3"
 * into a {@link NumberField}. Deliberately NOT `eval`/`new Function`: a
 * hand-written recursive-descent parser, so the only thing that can ever run is
 * arithmetic on the numbers in the string.
 *
 * Returns `null` for empty/invalid input (the field reverts to its prior value)
 * and for non-finite results such as divide-by-zero.
 */
export function evalNumberExpression(input: string): number | null {
  const src = input.trim();
  if (src === "") return null;

  let pos = 0;
  const peek = (): string => src[pos] ?? "";
  const skipSpace = (): void => {
    while (src[pos] === " " || src[pos] === "\t") pos++;
  };

  // expr = term (('+' | '-') term)*
  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    for (;;) {
      skipSpace();
      const op = peek();
      if (op !== "+" && op !== "-") break;
      pos++;
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  };

  // term = factor (('*' | '/') factor)*
  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    for (;;) {
      skipSpace();
      const op = peek();
      if (op !== "*" && op !== "/") break;
      pos++;
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };

  // factor = ('+' | '-') factor | '(' expr ')' | number
  const parseFactor = (): number | null => {
    skipSpace();
    const c = peek();
    if (c === "+" || c === "-") {
      pos++;
      const f = parseFactor();
      return f === null ? null : c === "-" ? -f : f;
    }
    if (c === "(") {
      pos++;
      const e = parseExpr();
      if (e === null) return null;
      skipSpace();
      if (peek() !== ")") return null;
      pos++;
      return e;
    }
    return parseNumber();
  };

  const parseNumber = (): number | null => {
    skipSpace();
    const start = pos;
    let dots = 0;
    for (;;) {
      const ch = src[pos];
      if (ch !== undefined && ch >= "0" && ch <= "9") {
        pos++;
      } else if (ch === ".") {
        if (++dots > 1) return null;
        pos++;
      } else {
        break;
      }
    }
    if (pos === start) return null;
    const n = Number.parseFloat(src.slice(start, pos));
    return Number.isFinite(n) ? n : null;
  };

  const result = parseExpr();
  if (result === null) return null;
  skipSpace();
  if (pos !== src.length) return null; // trailing junk → reject the whole input
  return Number.isFinite(result) ? result : null;
}
