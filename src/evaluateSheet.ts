/**
 * Orquestador de la evaluación de un libro completo.
 *
 * Es la pieza que hace posible que las funciones personalizadas no cuesten
 * una petición de red por celda. El núcleo del motor es síncrono y no sabe
 * de red; este orquestador recorre las celdas en orden de dependencias y,
 * en cada nivel, junta todas las invocaciones pendientes en **una sola**
 * llamada al puerto.
 *
 * El número de llamadas depende de la profundidad del grafo, no de cuántas
 * celdas invoquen funciones. Una hoja con cuarenta celdas independientes que
 * llaman a `QUADRATIC` hace una llamada, no cuarenta.
 */

import {
  buildGraph,
  getRecalcOrder,
  type DepGraph,
} from "./depGraph.js";
import { isFormulaContent } from "./graphicDirective.js";
import {
  evaluateCell,
  FORMULA_CIRCULAR,
  FORMULA_ERROR,
  type CellValueMap,
  type EvaluateContext,
  type PendingCustomCall,
} from "./evaluate.js";
import {
  buildRegistry,
  type CustomFunctionDefinition,
  type CustomFunctionResolver,
  type CustomFunctionResult,
} from "./customFunctions.js";
import { splitRef } from "./sheetRef.js";
import type { FormulaValue } from "./functions.js";

/** Una celda tal como la almacenan los consumidores. */
export interface SheetCell {
  /** Fórmula (`=A1*2`) o valor literal. */
  formula?: string;
}

/** Celdas del libro, indexadas por referencia canónica (`A1` o `Hoja1!A1`). */
export type SheetCells = Record<string, SheetCell | undefined>;

export interface EvaluateSheetOptions {
  /** Funciones personalizadas disponibles para estas celdas. */
  customFunctions?: readonly CustomFunctionDefinition[];
  /** Cómo resolver un lote de invocaciones. Sin esto, invocarlas es un error. */
  resolveCustomFunctions?: CustomFunctionResolver;
  /**
   * Celdas a recalcular. Por omisión, todas las que tengan fórmula.
   * Las dependientes de estas se recalculan siempre.
   */
  dirtyCells?: readonly string[];
  /** Valores de partida de las celdas sin fórmula. */
  initialValues?: CellValueMap;
}

export interface EvaluateSheetResult {
  /** Valor calculado de cada celda. */
  values: CellValueMap;
  /** Celdas que forman parte de una referencia circular. */
  circular: Set<string>;
  /** Número de llamadas al puerto: una por nivel con invocaciones pendientes. */
  batchCount: number;
}

/** Extrae el valor literal de una celda sin fórmula. */
const literalValue = (cell: SheetCell | undefined): FormulaValue => {
  const raw = cell?.formula;
  if (raw === undefined || raw === null) return "";
  const trimmed = String(raw).trim();
  if (trimmed === "") return "";
  // La celda de gráfico no es una fórmula: su literal es su propia directiva.
  if (isFormulaContent(trimmed)) return "";
  if (trimmed.startsWith("=")) return trimmed.slice(1).trimStart();
  const num = Number(trimmed);
  return Number.isNaN(num) ? trimmed : num;
};

/**
 * Evalúa las celdas indicadas y sus dependientes, resolviendo las funciones
 * personalizadas por lotes.
 */
export const evaluateSheet = async (
  cells: SheetCells,
  options: EvaluateSheetOptions = {},
): Promise<EvaluateSheetResult> => {
  const registry = buildRegistry(options.customFunctions ?? []);
  const graph: DepGraph = buildGraph(cells);

  // Las hojas del libro salen de las propias claves. Con ellas, una fórmula
  // que apunta a una hoja que no existe da error en vez de un cero silencioso.
  const knownSheets = new Set<string>();
  for (const ref of Object.keys(cells)) {
    const { sheet } = splitRef(ref);
    if (sheet !== undefined) knownSheets.add(sheet);
  }

  const values: CellValueMap = { ...options.initialValues };
  for (const ref of Object.keys(cells)) {
    if (!isFormulaContent(cells[ref]?.formula)) {
      values[ref] = literalValue(cells[ref]);
    }
  }

  const dirty =
    options.dirtyCells !== undefined
      ? [...options.dirtyCells]
      : Object.keys(cells);
  const { order, circular } = getRecalcOrder(graph, dirty);

  for (const ref of circular) values[ref] = FORMULA_CIRCULAR;

  let batchCount = 0;

  for (const level of groupByDependencyLevel(order, graph)) {
    batchCount += await evaluateLevel(
      level,
      cells,
      values,
      registry,
      knownSheets,
      options,
    );
  }

  return { values, circular, batchCount };
};

/**
 * Reparte las celdas ya ordenadas topológicamente en niveles: dentro de un
 * nivel ninguna celda depende de otra, así que todas pueden resolverse en el
 * mismo lote.
 */
const groupByDependencyLevel = (
  order: readonly string[],
  graph: DepGraph,
): string[][] => {
  const levelOf = new Map<string, number>();
  const levels: string[][] = [];

  for (const ref of order) {
    let level = 0;
    for (const precedent of graph.precedents.get(ref) ?? []) {
      const precedentLevel = levelOf.get(precedent);
      if (precedentLevel !== undefined) level = Math.max(level, precedentLevel + 1);
    }
    levelOf.set(ref, level);
    (levels[level] ??= []).push(ref);
  }

  return levels.filter((level) => level !== undefined);
};

/**
 * Evalúa un nivel completo. Devuelve cuántas llamadas al puerto hizo:
 * normalmente una, o varias si hay funciones personalizadas anidadas, que se
 * resuelven de dentro hacia fuera en vueltas sucesivas.
 */
const evaluateLevel = async (
  level: readonly string[],
  cells: SheetCells,
  values: CellValueMap,
  registry: ReturnType<typeof buildRegistry>,
  knownSheets: ReadonlySet<string>,
  options: EvaluateSheetOptions,
): Promise<number> => {
  // Resultados ya resueltos por celda, entre vuelta y vuelta.
  const resolved = new Map<string, Map<number, CustomFunctionResult>>();
  let remaining = [...level];
  let batches = 0;

  while (remaining.length > 0) {
    const stillPending: string[] = [];
    const batch: PendingCustomCall[] = [];
    const batchOwner: string[] = [];

    for (const ref of remaining) {
      const context: EvaluateContext = {
        sheet: splitRef(ref).sheet,
        customFunctions: registry,
        customResults: resolved.get(ref),
        knownSheets: knownSheets.size > 0 ? knownSheets : undefined,
      };

      const evaluation = evaluateCell(cells[ref]?.formula, values, context);

      if (evaluation.status === "ok") {
        values[ref] = evaluation.value;
        continue;
      }

      if (options.resolveCustomFunctions === undefined) {
        values[ref] = FORMULA_ERROR;
        continue;
      }

      stillPending.push(ref);
      for (const pending of evaluation.calls) {
        batch.push(pending);
        batchOwner.push(ref);
      }
    }

    if (batch.length === 0) {
      // Nada que resolver y aún hay celdas pendientes: no puede avanzar.
      for (const ref of stillPending) values[ref] = FORMULA_ERROR;
      break;
    }

    batches += 1;
    let results: CustomFunctionResult[];
    try {
      results = await options.resolveCustomFunctions!(
        batch.map((pending) => pending.call),
      );
    } catch {
      // Un fallo del puerto afecta solo a las celdas de este lote; las que
      // ya se calcularon conservan su valor.
      for (const ref of new Set(batchOwner)) values[ref] = FORMULA_ERROR;
      break;
    }

    batch.forEach((pending, index) => {
      const owner = batchOwner[index];
      const perCell = resolved.get(owner) ?? new Map<number, CustomFunctionResult>();
      perCell.set(
        pending.occurrence,
        results[index] ?? { error: "sin resultado para la invocación" },
      );
      resolved.set(owner, perCell);
    });

    remaining = stillPending;
  }

  return batches;
};
