/**
 * Built-in spreadsheet functions, each available under its Spanish name
 * (the one users type, matching the Excel templates) and its English
 * alias. Every function receives its arguments already evaluated by
 * `evaluate.ts` — a range like `P3:P7` arrives as a flat array of values.
 */

export type FormulaValue = number | string;
export type FormulaArg = FormulaValue | FormulaValue[];

/** Thrown by a function on invalid input; `evaluate.ts` turns this into `#ERROR`. */
export class FormulaError extends Error {}

const flatten = (args: FormulaArg[]): FormulaValue[] =>
  args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg]));

const toNumber = (value: FormulaValue): number => {
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) throw new FormulaError(`"${value}" is not a number`);
  return parsed;
};

const toText = (value: FormulaValue): string => String(value);

const requireArgs = (args: FormulaArg[], count: number, name: string): void => {
  if (args.length !== count) {
    throw new FormulaError(`${name} expects ${count} argument(s)`);
  }
};

const sum = (args: FormulaArg[]): number =>
  flatten(args).reduce<number>((total, value) => {
    const num = Number(value);
    return Number.isFinite(num) ? total + num : total;
  }, 0);

const average = (args: FormulaArg[]): number => {
  const values = flatten(args).filter((value) => Number.isFinite(Number(value)));
  if (values.length === 0) return 0;
  return sum(values) / values.length;
};

const len = (args: FormulaArg[]): number => {
  requireArgs(args, 1, "LARGO/LEN");
  return toText(flatten(args)[0]).length;
};

const ifFn = (args: FormulaArg[]): FormulaValue => {
  requireArgs(args, 3, "SI/IF");
  const [condition, whenTrue, whenFalse] = flatten(args);
  const isTruthy =
    typeof condition === "number" ? condition !== 0 : Boolean(condition);
  return isTruthy ? whenTrue : whenFalse;
};

const round = (args: FormulaArg[]): number => {
  requireArgs(args, 2, "REDONDEAR/ROUND");
  const [value, decimals] = flatten(args).map(toNumber);
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const concat = (args: FormulaArg[]): string =>
  flatten(args)
    .map(toText)
    .join("");

const left = (args: FormulaArg[]): string => {
  requireArgs(args, 2, "IZQUIERDA/LEFT");
  const [text, count] = flatten(args);
  return toText(text).slice(0, toNumber(count));
};

const right = (args: FormulaArg[]): string => {
  requireArgs(args, 2, "DERECHA/RIGHT");
  const [text, count] = flatten(args);
  const n = toNumber(count);
  return n <= 0 ? "" : toText(text).slice(-n);
};

export type FormulaFunction = (args: FormulaArg[]) => FormulaValue;

export const FUNCTIONS: Record<string, FormulaFunction> = {
  SUMA: sum,
  SUM: sum,
  PROMEDIO: average,
  AVERAGE: average,
  LARGO: len,
  LEN: len,
  SI: ifFn,
  IF: ifFn,
  REDONDEAR: round,
  ROUND: round,
  CONCATENAR: concat,
  CONCAT: concat,
  IZQUIERDA: left,
  LEFT: left,
  DERECHA: right,
  RIGHT: right,
};

export const isKnownFunction = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(FUNCTIONS, name.toUpperCase());

export const callFunction = (name: string, args: FormulaArg[]): FormulaValue => {
  const fn = FUNCTIONS[name.toUpperCase()];
  if (!fn) throw new FormulaError(`Unknown function "${name}"`);
  return fn(args);
};
