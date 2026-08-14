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

import { expandRangeToGrid, isRangeRef } from "./cellRef.js";
import { callFunction, type FormulaArg, type FormulaValue } from "./functions.js";
import type {
  CustomFunctionCall,
  CustomFunctionRegistry,
  CustomFunctionResult,
} from "./customFunctions.js";
import {
  isQualifiedRef,
  normalizeRef,
  parseQualifiedRef,
  QUALIFIED_REF_SOURCE,
  qualify,
  splitRef,
} from "./sheetRef.js";

export type CellValueMap = Record<string, FormulaValue | undefined>;

/** Value shown for a cell whose formula is invalid or fails to evaluate. */
export const FORMULA_ERROR = "#ERROR";
/** Value shown for a cell that is part of a circular reference (see depGraph.ts). */
export const FORMULA_CIRCULAR = "#CIRCULAR";
/** Value shown for a cell whose custom-function arguments don't match the declaration. */
export const FORMULA_BAD_ARGS = "#ARGS";

/** Thrown for any malformed input; the public API turns this into `#ERROR`. */
class ParseError extends Error {}

/** Thrown when a custom function is invoked with the wrong number of arguments. */
class ArityError extends Error {}

/**
 * Marca interna para un valor que todavía no se puede calcular porque
 * depende de una función personalizada sin resolver. Se propaga por los
 * operadores en vez de fallar: la celda se reevalúa entera cuando el lote
 * de invocaciones vuelve resuelto.
 */
const UNRESOLVED = Symbol("unresolved");
type StackValue = FormulaArg | typeof UNRESOLVED;

const isUnresolved = (value: StackValue): value is typeof UNRESOLVED =>
  value === UNRESOLVED;

/** Invocación de función personalizada pendiente de resolver. */
export interface PendingCustomCall {
  /** Posición de la invocación dentro de la fórmula, contando solo las personalizadas. */
  occurrence: number;
  call: CustomFunctionCall;
}

/** Contexto opcional de evaluación: hoja actual y funciones personalizadas. */
export interface EvaluateContext {
  /** Hoja a la que pertenece la fórmula; califica sus referencias locales. */
  sheet?: string;
  /** Funciones personalizadas reconocibles en la fórmula. */
  customFunctions?: CustomFunctionRegistry;
  /** Resultados ya resueltos, por posición de aparición. */
  customResults?: ReadonlyMap<number, CustomFunctionResult>;
  /**
   * Hojas que existen en el libro. Cuando se indica, una referencia a una
   * hoja ausente es un error en vez de un cero.
   *
   * Una celda vacía vale cero, pero una hoja que no existe es una fórmula
   * equivocada, y conviene que se note. Si no se indica el conjunto, no hay
   * forma de distinguir ambos casos y se mantiene el cero.
   */
  knownSheets?: ReadonlySet<string>;
}

/** Resultado de evaluar una celda: un valor, o invocaciones por resolver. */
export type CellEvaluation =
  | { status: "ok"; value: FormulaValue }
  | { status: "pending"; calls: PendingCustomCall[] };

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

/**
 * Las alternativas se prueban en orden, y ese orden importa:
 *
 * - El literal de texto va antes que todo lo demás, de modo que un
 *   `="El COST(total) es:"` sea texto y no una invocación de función.
 * - La referencia calificada por hoja va antes que la simple, para que
 *   `Hoja1!A1` no se parta en el identificador `Hoja1` y la referencia `A1`.
 * - El identificador de función solo se reconoce si le sigue un paréntesis,
 *   y captura el nombre completo. Por eso `ASSOCIATE_COST(` nunca puede
 *   leerse como `COST(`: un tokenizador no parte identificadores por la
 *   mitad, que es justo el defecto del resolutor por expresión regular al
 *   que este motor sustituye.
 */
const TOKEN_PATTERN = new RegExp(
  [
    "\\s+",
    '"(?:[^"\\\\]|\\\\.)*"',
    QUALIFIED_REF_SOURCE,
    "\\$?[A-Za-z]+\\$?\\d+:\\$?[A-Za-z]+\\$?\\d+",
    "\\$?[A-Za-z]+\\$?\\d+",
    "[A-Za-z_][A-Za-z0-9_]*(?=\\()",
    // Literales booleanos sueltos: los usa el ejemplo de la ayuda del
    // diseñador, `=BUSCARV(A1, B1:E10, 3, TRUE)`. Sin ellos, esa fórmula
    // tal como está documentada no se puede analizar.
    "(?:TRUE|FALSE|VERDADERO|FALSO)\\b",
    "\\d+(?:\\.\\d+)?",
    "<=",
    ">=",
    "<>",
    "[+\\-*/^&=<>(),]",
  ].join("|"),
  "g",
);

/** `TRUE`/`FALSE` y sus nombres en español, como 1 y 0. */
const BOOLEAN_LITERALS = new Map<string, number>([
  ["TRUE", 1],
  ["VERDADERO", 1],
  ["FALSE", 0],
  ["FALSO", 0],
]);

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
    } else if (BOOLEAN_LITERALS.has(text.toUpperCase())) {
      tokens.push({
        type: "number",
        value: BOOLEAN_LITERALS.get(text.toUpperCase())!,
      });
    } else if (isQualifiedRef(text)) {
      const qualified = parseQualifiedRef(text)!;
      const canonical = qualify(qualified.sheet, qualified.cell);
      tokens.push({
        type: qualified.cell.includes(":") ? "range" : "ref",
        value: canonical,
      });
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
        // Un paréntesis que cierra justo después del que abre es una llamada
        // sin argumentos, como `PI()`. Sin esta comprobación se contaría un
        // argumento que nunca se apiló y la evaluación fallaría.
        const emptyCall = previous?.type === "lparen";

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
          const counted = argCounts.pop() ?? 0;
          output.push({
            type: "call",
            name: funcMarker.value,
            argCount: emptyCall ? 0 : counted,
          });
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

const resolveRef = (
  ref: string,
  cellValues: CellValueMap,
  context: EvaluateContext,
): FormulaValue => {
  const isQualified = ref.includes("!");
  const canonical = normalizeRef(ref, isQualified ? undefined : context.sheet);

  if (isQualified && context.knownSheets !== undefined) {
    const { sheet } = splitRef(canonical);
    if (sheet !== undefined && !context.knownSheets.has(sheet)) {
      throw new ParseError(`La hoja "${sheet}" no existe`);
    }
  }

  const value = cellValues[canonical];
  return value === undefined || value === null || value === "" ? 0 : value;
};

/**
 * Expande un rango a sus celdas, conservando el calificador de hoja cuando
 * lo lleva: `Hoja1!A1:B2` produce `Hoja1!A1`, `Hoja1!B1`, ...
 */
/**
 * Expande un rango a sus celdas conservando la forma de tabla, y el
 * calificador de hoja cuando lo lleva: `Hoja1!A1:B2` produce
 * `[[Hoja1!A1, Hoja1!B1], [Hoja1!A2, Hoja1!B2]]`.
 */
const expandAnyRangeToGrid = (range: string): string[][] => {
  const separator = range.lastIndexOf("!");
  if (separator === -1) return expandRangeToGrid(range);

  const sheet = range.slice(0, separator);
  return expandRangeToGrid(range.slice(separator + 1)).map((row) =>
    row.map((ref) => qualify(sheet, ref)),
  );
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

/**
 * Evaluates a Reverse Polish Notation token list against `cellValues`.
 *
 * Cuando la fórmula invoca funciones personalizadas todavía sin resolver,
 * las acumula en `pending` y devuelve `UNRESOLVED`: el orquestador resuelve
 * el lote y vuelve a llamar con los resultados disponibles.
 */
const evalRPN = (
  rpn: RPNToken[],
  cellValues: CellValueMap,
  context: EvaluateContext,
  pending: PendingCustomCall[],
): StackValue => {
  const stack: StackValue[] = [];
  const customFunctions = context.customFunctions;
  let occurrence = 0;

  for (const token of rpn) {
    switch (token.type) {
      case "value":
        stack.push(token.value);
        break;
      case "ref":
        stack.push(resolveRef(token.value, cellValues, context));
        break;
      case "range":
        // Con forma de tabla: `SUMA` la aplana sin enterarse, pero `BUSCARV`
        // necesita saber qué celda está en qué columna.
        stack.push(
          expandAnyRangeToGrid(token.value).map((row) =>
            row.map((ref) => resolveRef(ref, cellValues, context)),
          ),
        );
        break;
      case "unaryMinus": {
        const operand = stack.pop();
        if (operand === undefined || Array.isArray(operand)) {
          throw new ParseError("Malformed expression");
        }
        if (isUnresolved(operand)) {
          stack.push(UNRESOLVED);
          break;
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
        if (isUnresolved(a) || isUnresolved(b)) {
          stack.push(UNRESOLVED);
          break;
        }
        stack.push(applyBinaryOp(token.op, a, b));
        break;
      }
      case "call": {
        if (stack.length < token.argCount) {
          throw new ParseError(`Not enough arguments for ${token.name}`);
        }
        const args = stack.splice(stack.length - token.argCount, token.argCount);

        const definition = customFunctions?.get(token.name);
        if (definition) {
          stack.push(
            resolveCustomCall(definition, args, occurrence++, context, pending),
          );
          break;
        }

        if (args.some(isUnresolved)) {
          stack.push(UNRESOLVED);
          break;
        }
        stack.push(callFunction(token.name, args as FormulaArg[]));
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
 * Resuelve una invocación de función personalizada, o la deja pendiente.
 *
 * La comprobación de aridad es lo primero y ocurre siempre: una invocación
 * con el número de argumentos equivocado es un error de la hoja, y no tiene
 * sentido gastar una petición de red en descubrirlo.
 */
const resolveCustomCall = (
  definition: { code: string; variables: string[] },
  args: StackValue[],
  occurrence: number,
  context: EvaluateContext,
  pending: PendingCustomCall[],
): StackValue => {
  if (args.length !== definition.variables.length) {
    throw new ArityError(
      `${definition.code} espera ${definition.variables.length} argumento(s) y recibió ${args.length}`,
    );
  }

  const alreadyResolved = context.customResults?.get(occurrence);
  if (alreadyResolved) {
    if (alreadyResolved.error !== undefined) {
      throw new ParseError(alreadyResolved.error);
    }
    return alreadyResolved.value ?? 0;
  }

  // Un argumento sin resolver significa una función personalizada anidada:
  // se resolverá en la siguiente vuelta, cuando su valor ya exista.
  if (args.some((arg) => isUnresolved(arg) || Array.isArray(arg))) {
    return UNRESOLVED;
  }

  const parameters: Record<string, number> = {};
  definition.variables.forEach((variable, index) => {
    parameters[variable] = toNumber(args[index] as FormulaValue);
  });

  pending.push({ occurrence, call: { definition, parameters } });
  return UNRESOLVED;
};

/**
 * Evaluates the expression after the leading `=` (i.e. `P3/O3`, not
 * `=P3/O3`) against `cellValues`. Returns `#ERROR` instead of throwing.
 */
export const evaluateExpression = (
  expression: string,
  cellValues: CellValueMap,
  context: EvaluateContext = {},
): FormulaValue => {
  const result = evaluateExpressionDetailed(expression, cellValues, context);
  // Sin orquestador que resuelva el lote, una función personalizada sin
  // resolver no puede dar un valor: la celda queda en error.
  return result.status === "ok" ? result.value : FORMULA_ERROR;
};

/**
 * Igual que `evaluateExpression`, pero distingue entre un valor y una
 * fórmula que espera la resolución de funciones personalizadas.
 */
export const evaluateExpressionDetailed = (
  expression: string,
  cellValues: CellValueMap,
  context: EvaluateContext = {},
): CellEvaluation => {
  const pending: PendingCustomCall[] = [];
  try {
    const tokens = tokenize(expression);
    if (tokens.length === 0) throw new ParseError("Empty expression");
    const value = evalRPN(toRPN(tokens), cellValues, context, pending);

    if (isUnresolved(value)) {
      // Sin invocaciones que resolver, un valor sin resolver solo puede
      // venir de una fórmula malformada.
      if (pending.length === 0) return { status: "ok", value: FORMULA_ERROR };
      return { status: "pending", calls: pending };
    }
    if (Array.isArray(value)) return { status: "ok", value: FORMULA_ERROR };
    return { status: "ok", value };
  } catch (error) {
    return {
      status: "ok",
      value: error instanceof ArityError ? FORMULA_BAD_ARGS : FORMULA_ERROR,
    };
  }
};

/**
 * Evaluates a full cell entry: a formula (`=...`), a numeric literal, or
 * plain text. This is the main entry point used by the grid.
 */
export const evaluateFormula = (
  formula: string | undefined | null,
  cellValues: CellValueMap,
  context: EvaluateContext = {},
): FormulaValue => {
  const result = evaluateCell(formula, cellValues, context);
  return result.status === "ok" ? result.value : FORMULA_ERROR;
};

/**
 * Igual que `evaluateFormula`, pero informa si la celda quedó a la espera de
 * resolver funciones personalizadas. Lo usa `evaluateSheet`.
 */
export const evaluateCell = (
  formula: string | undefined | null,
  cellValues: CellValueMap,
  context: EvaluateContext = {},
): CellEvaluation => {
  if (formula === undefined || formula === null) return { status: "ok", value: "" };
  const trimmed = String(formula).trim();
  if (trimmed === "") return { status: "ok", value: "" };
  if (!trimmed.startsWith("=")) {
    const num = Number(trimmed);
    return { status: "ok", value: Number.isNaN(num) ? trimmed : num };
  }
  return evaluateExpressionDetailed(trimmed.slice(1), cellValues, context);
};
