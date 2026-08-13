/**
 * Formula evaluator: parses a formula (`=P3/O3`, `=SUMA(P3:P7)`, ...)
 * against a map of already-computed cell values and returns its result.
 *
 * Deliberately does NOT use `eval` or `new Function()` — the input comes
 * from a `.xlsx` uploaded by a user, and evaluating it as JavaScript would
 * be an arbitrary-code-execution hole in the admin's browser (see
 * design.md, decision 4). Instead this implements its own small
 * expression parser: a tokenizer, a shunting-yard pass to Reverse Polish
 * Notation, and a stack-based RPN evaluator.
 */

import { expandRange, isRangeRef } from "./cellRef.js";
import { callFunction, type FormulaArg, type FormulaValue } from "./functions.js";

export type CellValueMap = Record<string, FormulaValue | undefined>;

/** Value shown for a cell whose formula is invalid or fails to evaluate. */
export const FORMULA_ERROR = "#ERROR";
/** Value shown for a cell that is part of a circular reference (see depGraph.ts). */
export const FORMULA_CIRCULAR = "#CIRCULAR";

/** Thrown for any malformed input; the public API turns this into `#ERROR`. */
class ParseError extends Error {}

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "ref"; value: string }
  | { type: "range"; value: string }
  | { type: "func"; value: string }
  | { type: "op"; value: string }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "comma" };

const TOKEN_PATTERN =
  /\s+|"(?:[^"\\]|\\.)*"|\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+|\$?[A-Za-z]+\$?\d+|[A-Za-z_][A-Za-z0-9_]*(?=\()|\d+(?:\.\d+)?|<=|>=|<>|[+\-*/^&=<>(),]/g;

const unescapeString = (literal: string): string =>
  literal
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

const stripAbsoluteMarkers = (ref: string): string =>
  ref.replace(/\$/g, "").toUpperCase();

/** Splits an expression into tokens, or throws `ParseError` on unrecognized input. */
const tokenize = (expression: string): Token[] => {
  const tokens: Token[] = [];
  let cursor = 0;
  TOKEN_PATTERN.lastIndex = 0;

  while (cursor < expression.length) {
    TOKEN_PATTERN.lastIndex = cursor;
    const match = TOKEN_PATTERN.exec(expression);
    if (!match || match.index !== cursor) {
      throw new ParseError(`Unexpected character at "${expression.slice(cursor)}"`);
    }

    const text = match[0];
    cursor += text.length;

    if (/^\s+$/.test(text)) continue;
    if (text.startsWith('"')) {
      tokens.push({ type: "string", value: unescapeString(text) });
    } else if (isRangeRef(stripAbsoluteMarkers(text))) {
      tokens.push({ type: "range", value: stripAbsoluteMarkers(text) });
    } else if (/^\$?[A-Za-z]+\$?\d+$/.test(text)) {
      tokens.push({ type: "ref", value: stripAbsoluteMarkers(text) });
    } else if (/^[A-Za-z_]/.test(text)) {
      tokens.push({ type: "func", value: text.toUpperCase() });
    } else if (/^\d/.test(text)) {
      tokens.push({ type: "number", value: Number.parseFloat(text) });
    } else if (text === "(") {
      tokens.push({ type: "lparen" });
    } else if (text === ")") {
      tokens.push({ type: "rparen" });
    } else if (text === ",") {
      tokens.push({ type: "comma" });
    } else {
      tokens.push({ type: "op", value: text });
    }
  }

  return tokens;
};

type RPNToken =
  | { type: "value"; value: number | string }
  | { type: "ref"; value: string }
  | { type: "range"; value: string }
  | { type: "binary"; op: string }
  | { type: "unaryMinus" }
  | { type: "call"; name: string; argCount: number };

const PRECEDENCE: Record<string, number> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  ">": 1,
  "<=": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 5,
};

const isRightAssociative = (op: string): boolean => op === "^";

type StackItem =
  | { kind: "op"; value: string }
  | { kind: "unaryMinus" }
  | { kind: "lparen"; isCall: boolean }
  | { kind: "func"; value: string };

/** Converts infix tokens to Reverse Polish Notation via the shunting-yard algorithm. */
const toRPN = (tokens: Token[]): RPNToken[] => {
  const output: RPNToken[] = [];
  const stack: StackItem[] = [];
  const argCounts: number[] = [];

  let previous: Token | undefined;
  const isUnaryContext = (): boolean =>
    previous === undefined ||
    previous.type === "op" ||
    previous.type === "lparen" ||
    previous.type === "comma";

  const popOperatorToOutput = (item: StackItem): void => {
    if (item.kind === "op") output.push({ type: "binary", op: item.value });
    else if (item.kind === "unaryMinus") output.push({ type: "unaryMinus" });
    else throw new ParseError("Malformed expression");
  };

  for (const token of tokens) {
    switch (token.type) {
      case "number":
        output.push({ type: "value", value: token.value });
        break;
      case "string":
        output.push({ type: "value", value: token.value });
        break;
      case "ref":
        output.push({ type: "ref", value: token.value });
        break;
      case "range":
        output.push({ type: "range", value: token.value });
        break;
      case "func":
        stack.push({ kind: "func", value: token.value });
        break;
      case "lparen": {
        const precedingWasFunc =
          stack.length > 0 && stack[stack.length - 1].kind === "func";
        stack.push({ kind: "lparen", isCall: precedingWasFunc });
        if (precedingWasFunc) argCounts.push(1);
        break;
      }
      case "rparen": {
        while (stack.length > 0 && stack[stack.length - 1].kind !== "lparen") {
          popOperatorToOutput(stack.pop()!);
        }
        const opened = stack.pop();
        if (!opened || opened.kind !== "lparen") {
          throw new ParseError("Mismatched parentheses");
        }
        if (opened.isCall) {
          const funcMarker = stack.pop();
          if (!funcMarker || funcMarker.kind !== "func") {
            throw new ParseError("Malformed function call");
          }
          const argCount = argCounts.pop() ?? 0;
          output.push({ type: "call", name: funcMarker.value, argCount });
        }
        break;
      }
      case "comma": {
        while (stack.length > 0 && stack[stack.length - 1].kind !== "lparen") {
          popOperatorToOutput(stack.pop()!);
        }
        if (argCounts.length === 0) {
          throw new ParseError("Comma outside of a function call");
        }
        argCounts[argCounts.length - 1] += 1;
        break;
      }
      case "op": {
        if (token.value === "-" && isUnaryContext()) {
          stack.push({ kind: "unaryMinus" });
          break;
        }
        if (token.value === "+" && isUnaryContext()) {
          break; // unary plus is a no-op
        }

        const precedence = PRECEDENCE[token.value];
        if (precedence === undefined) {
          throw new ParseError(`Unknown operator "${token.value}"`);
        }

        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.kind === "lparen" || top.kind === "func") break;
          const topPrecedence =
            top.kind === "unaryMinus" ? 6 : PRECEDENCE[top.value];
          const shouldPop =
            topPrecedence > precedence ||
            (topPrecedence === precedence && !isRightAssociative(token.value));
          if (!shouldPop) break;
          popOperatorToOutput(stack.pop()!);
        }

        stack.push({ kind: "op", value: token.value });
        break;
      }
    }
    previous = token;
  }

  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.kind === "lparen" || item.kind === "func") {
      throw new ParseError("Mismatched parentheses");
    }
    popOperatorToOutput(item);
  }

  return output;
};

const resolveRef = (ref: string, cellValues: CellValueMap): FormulaValue => {
  const value = cellValues[ref];
  return value === undefined || value === null || value === "" ? 0 : value;
};

const toNumber = (value: FormulaValue): number => {
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) throw new ParseError(`"${value}" is not a number`);
  return parsed;
};

const toText = (value: FormulaValue): string => String(value);

const compare = (op: string, a: FormulaValue, b: FormulaValue): number => {
  const bothNumeric = typeof a === "number" && typeof b === "number";
  const left = bothNumeric ? (a as number) : toText(a);
  const right = bothNumeric ? (b as number) : toText(b);
  const result = (() => {
    switch (op) {
      case "=":
        return left === right;
      case "<>":
        return left !== right;
      case "<":
        return left < right;
      case ">":
        return left > right;
      case "<=":
        return left <= right;
      case ">=":
        return left >= right;
      default:
        throw new ParseError(`Unknown comparator "${op}"`);
    }
  })();
  return result ? 1 : 0;
};

const applyBinaryOp = (
  op: string,
  a: FormulaValue,
  b: FormulaValue,
): FormulaValue => {
  switch (op) {
    case "+":
      return toNumber(a) + toNumber(b);
    case "-":
      return toNumber(a) - toNumber(b);
    case "*":
      return toNumber(a) * toNumber(b);
    case "/": {
      const divisor = toNumber(b);
      if (divisor === 0) throw new ParseError("Division by zero");
      return toNumber(a) / divisor;
    }
    case "^":
      return toNumber(a) ** toNumber(b);
    case "&":
      return toText(a) + toText(b);
    default:
      return compare(op, a, b);
  }
};

/** Evaluates a Reverse Polish Notation token list against `cellValues`. */
const evalRPN = (rpn: RPNToken[], cellValues: CellValueMap): FormulaValue => {
  const stack: FormulaArg[] = [];

  for (const token of rpn) {
    switch (token.type) {
      case "value":
        stack.push(token.value);
        break;
      case "ref":
        stack.push(resolveRef(token.value, cellValues));
        break;
      case "range":
        stack.push(expandRange(token.value).map((ref) => resolveRef(ref, cellValues)));
        break;
      case "unaryMinus": {
        const operand = stack.pop();
        if (operand === undefined || Array.isArray(operand)) {
          throw new ParseError("Malformed expression");
        }
        stack.push(-toNumber(operand));
        break;
      }
      case "binary": {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined || Array.isArray(a) || Array.isArray(b)) {
          throw new ParseError("Malformed expression");
        }
        stack.push(applyBinaryOp(token.op, a, b));
        break;
      }
      case "call": {
        if (stack.length < token.argCount) {
          throw new ParseError(`Not enough arguments for ${token.name}`);
        }
        const args = stack.splice(stack.length - token.argCount, token.argCount);
        stack.push(callFunction(token.name, args));
        break;
      }
    }
  }

  if (stack.length !== 1 || Array.isArray(stack[0])) {
    throw new ParseError("Malformed expression");
  }
  return stack[0];
};

/**
 * Evaluates the expression after the leading `=` (i.e. `P3/O3`, not
 * `=P3/O3`) against `cellValues`. Returns `#ERROR` instead of throwing.
 */
export const evaluateExpression = (
  expression: string,
  cellValues: CellValueMap,
): FormulaValue => {
  try {
    const tokens = tokenize(expression);
    if (tokens.length === 0) throw new ParseError("Empty expression");
    const rpn = toRPN(tokens);
    return evalRPN(rpn, cellValues);
  } catch {
    return FORMULA_ERROR;
  }
};

/**
 * Evaluates a full cell entry: a formula (`=...`), a numeric literal, or
 * plain text. This is the main entry point used by the grid.
 */
export const evaluateFormula = (
  formula: string | undefined | null,
  cellValues: CellValueMap,
): FormulaValue => {
  if (formula === undefined || formula === null) return "";
  const trimmed = String(formula).trim();
  if (trimmed === "") return "";
  if (!trimmed.startsWith("=")) {
    const num = Number(trimmed);
    return Number.isNaN(num) ? trimmed : num;
  }
  return evaluateExpression(trimmed.slice(1), cellValues);
};
