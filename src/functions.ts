/**
 * Built-in spreadsheet functions, each available under its Spanish name
 * (the one users type, matching the Excel templates) and its English
 * alias. Every function receives its arguments already evaluated by
 * `evaluate.ts` — a range like `P3:P7` arrives as a flat array of values.
 */

export type FormulaValue = number | string;
/** Un rango conserva su forma de tabla: una entrada por fila. */
export type FormulaRange = FormulaValue[][];
export type FormulaArg = FormulaValue | FormulaValue[] | FormulaRange;

/** Thrown by a function on invalid input; `evaluate.ts` turns this into `#ERROR`. */
export class FormulaError extends Error {}

/** Aplana argumentos sueltos y rangos, sea cual sea su forma. */
const flatten = (args: FormulaArg[]): FormulaValue[] =>
  args.flatMap((arg) =>
    Array.isArray(arg) ? (arg.flat() as FormulaValue[]) : [arg],
  );

/** Devuelve un argumento como matriz de filas, si lo es. */
const asGrid = (arg: FormulaArg | undefined): FormulaRange | null => {
  if (!Array.isArray(arg)) return null;
  return arg.every((row) => Array.isArray(row))
    ? (arg as FormulaRange)
    : [arg as FormulaValue[]];
};

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

/**
 * Funciones matemáticas de un solo argumento.
 *
 * El conjunto y sus nombres replican los que ya acepta el diseñador de
 * project-front, que los traduce a `Math.*`. Sin ellos, adoptar este motor
 * allí convertiría en error cualquier hoja que use `=RAIZ(A1)` o `=ABS(...)`.
 *
 * Un resultado no finito se trata como error, igual que la división por cero:
 * `NaN` o `Infinity` en una celda no es un dato, es un cálculo que salió mal.
 */
const requireFinite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) {
    throw new FormulaError(`${name} no produjo un número finito`);
  }
  return value;
};

const unaryMath =
  (name: string, fn: (value: number) => number): FormulaFunction =>
  (args: FormulaArg[]) => {
    requireArgs(args, 1, name);
    return requireFinite(fn(toNumber(flatten(args)[0])), name);
  };

const power = (args: FormulaArg[]): number => {
  requireArgs(args, 2, "POTENCIA/POWER");
  const [base, exponent] = flatten(args).map(toNumber);
  return requireFinite(base ** exponent, "POTENCIA/POWER");
};

const pi = (args: FormulaArg[]): number => {
  requireArgs(args, 0, "PI");
  return Math.PI;
};

/** `Y`/`AND`: 1 si todos los argumentos son ciertos, 0 si alguno no lo es. */
const and = (args: FormulaArg[]): number => {
  const values = flatten(args);
  if (values.length === 0) throw new FormulaError("Y/AND necesita argumentos");
  return values.every(isTruthy) ? 1 : 0;
};

/** `O`/`OR`: 1 si algún argumento es cierto. */
const or = (args: FormulaArg[]): number => {
  const values = flatten(args);
  if (values.length === 0) throw new FormulaError("O/OR necesita argumentos");
  return values.some(isTruthy) ? 1 : 0;
};

const isTruthy = (value: FormulaValue): boolean =>
  typeof value === "number" ? value !== 0 : Boolean(value);

/**
 * `BUSCARV`/`VLOOKUP`: busca un valor en la primera columna de una tabla y
 * devuelve el de la columna indicada.
 *
 * Replica la semántica del diseñador de project-front, incluida la tolerancia
 * de 0.0001 al comparar números y la búsqueda aproximada sobre datos
 * ordenados. Una diferencia deliberada: si la celda encontrada contiene
 * texto, aquí se devuelve el texto; el evaluador anterior devolvía 0, porque
 * sustituía el resultado dentro de una expresión de JavaScript.
 */
const vlookup = (args: FormulaArg[]): FormulaValue => {
  if (args.length < 3) {
    throw new FormulaError("BUSCARV/VLOOKUP espera al menos 3 argumentos");
  }

  const [needle, table, columnArg, exactArg] = args;
  const grid = asGrid(table);
  if (grid === null || grid.length === 0) {
    throw new FormulaError("BUSCARV/VLOOKUP necesita un rango como tabla");
  }

  const column = toNumber(columnArg as FormulaValue);
  if (!Number.isInteger(column) || column < 1) {
    throw new FormulaError("El número de columna debe ser un entero desde 1");
  }

  const exact =
    exactArg === undefined
      ? true
      : typeof exactArg === "number"
        ? exactArg !== 0
        : String(exactArg).toLowerCase() === "true" || exactArg === "1";

  const target = needle as FormulaValue;
  const matches = (candidate: FormulaValue): boolean =>
    typeof target === "number" && typeof candidate === "number"
      ? Math.abs(target - candidate) < 0.0001
      : String(candidate).toLowerCase() === String(target).toLowerCase();

  const valueAt = (row: FormulaValue[]): FormulaValue => {
    const found = row[column - 1];
    if (found === undefined) {
      throw new FormulaError(`La tabla no tiene ${column} columna(s)`);
    }
    return found;
  };

  if (exact) {
    for (const row of grid) {
      if (row.length > 0 && matches(row[0])) return valueAt(row);
    }
    throw new FormulaError("BUSCARV/VLOOKUP no encontró el valor");
  }

  // Aproximada: la última fila cuyo primer valor no supera al buscado.
  let lastMatch: FormulaValue[] | null = null;
  for (const row of grid) {
    const candidate = row[0];
    const beyond =
      typeof target === "number" && typeof candidate === "number"
        ? candidate > target
        : String(candidate).toLowerCase() > String(target).toLowerCase();
    if (beyond) break;
    lastMatch = row;
  }

  if (lastMatch === null) {
    throw new FormulaError("BUSCARV/VLOOKUP no encontró el valor");
  }
  return valueAt(lastMatch);
};

/**
 * `COINCIDIR`/`MATCH`: posición (empezando en 1) de un valor dentro de un
 * rango. El tipo 0 exige coincidencia exacta; 1 (por omisión) busca el mayor
 * valor que no supere al buscado, sobre datos ordenados.
 */
const match = (args: FormulaArg[]): number => {
  if (args.length < 2) {
    throw new FormulaError("COINCIDIR/MATCH espera al menos 2 argumentos");
  }

  const [needle, range, typeArg] = args;
  const values = flatten([range]);
  const target = needle as FormulaValue;
  const matchType = typeArg === undefined ? 1 : toNumber(typeArg as FormulaValue);

  const equals = (candidate: FormulaValue): boolean =>
    typeof target === "number" && typeof candidate === "number"
      ? Math.abs(target - candidate) < 0.0001
      : String(candidate).toLowerCase() === String(target).toLowerCase();

  if (matchType === 0) {
    const index = values.findIndex(equals);
    if (index === -1) throw new FormulaError("COINCIDIR/MATCH no encontró el valor");
    return index + 1;
  }

  let last = -1;
  for (let index = 0; index < values.length; index++) {
    const candidate = values[index];
    const beyond =
      typeof target === "number" && typeof candidate === "number"
        ? candidate > target
        : String(candidate).toLowerCase() > String(target).toLowerCase();
    if (beyond) break;
    last = index;
  }

  if (last === -1) throw new FormulaError("COINCIDIR/MATCH no encontró el valor");
  return last + 1;
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

  // Trigonometría, en radianes.
  SENO: unaryMath("SENO/SIN", Math.sin),
  SIN: unaryMath("SENO/SIN", Math.sin),
  COSENO: unaryMath("COSENO/COS", Math.cos),
  COS: unaryMath("COSENO/COS", Math.cos),
  TANGENTE: unaryMath("TANGENTE/TAN", Math.tan),
  TAN: unaryMath("TANGENTE/TAN", Math.tan),
  ASENO: unaryMath("ASENO/ASIN", Math.asin),
  ASIN: unaryMath("ASENO/ASIN", Math.asin),
  ACOSENO: unaryMath("ACOSENO/ACOS", Math.acos),
  ACOS: unaryMath("ACOSENO/ACOS", Math.acos),
  ATAN: unaryMath("ATAN", Math.atan),

  // Logaritmos: LOG es en base 10, como en una hoja de cálculo.
  LOGARITMO: unaryMath("LOGARITMO/LOG", Math.log10),
  LOG: unaryMath("LOGARITMO/LOG", Math.log10),
  LN: unaryMath("LN", Math.log),

  // Aritmética
  RAIZ: unaryMath("RAIZ/SQRT", Math.sqrt),
  SQRT: unaryMath("RAIZ/SQRT", Math.sqrt),
  ABS: unaryMath("ABS", Math.abs),
  POTENCIA: power,
  POWER: power,
  TECHO: unaryMath("TECHO/CEILING", Math.ceil),
  CEILING: unaryMath("TECHO/CEILING", Math.ceil),
  PISO: unaryMath("PISO/FLOOR", Math.floor),
  FLOOR: unaryMath("PISO/FLOOR", Math.floor),
  PI: pi,

  // Conversión de ángulos
  RADIANES: unaryMath("RADIANES/RADIANS", (value) => (Math.PI / 180) * value),
  RADIANS: unaryMath("RADIANES/RADIANS", (value) => (Math.PI / 180) * value),
  GRADOS: unaryMath("GRADOS/DEGREES", (value) => (180 / Math.PI) * value),
  DEGREES: unaryMath("GRADOS/DEGREES", (value) => (180 / Math.PI) * value),

  // Búsqueda en tablas
  BUSCARV: vlookup,
  VLOOKUP: vlookup,
  COINCIDIR: match,
  MATCH: match,

  // Lógica
  Y: and,
  AND: and,
  O: or,
  OR: or,
};

export const isKnownFunction = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(FUNCTIONS, name.toUpperCase());

export const callFunction = (name: string, args: FormulaArg[]): FormulaValue => {
  const fn = FUNCTIONS[name.toUpperCase()];
  if (!fn) throw new FormulaError(`Unknown function "${name}"`);
  return fn(args);
};
