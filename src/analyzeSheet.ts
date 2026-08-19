/**
 * Análisis estático de un libro: qué está mal escrito, sin calcular nada.
 *
 * El motor ya sabía diagnosticar, pero solo evaluando, y evaluar significa
 * resolver las funciones personalizadas, y resolverlas es una petición de red
 * por nivel de dependencia. Eso vale para calcular; no vale para decirle a
 * quien escribe una plantilla que se equivocó de nombre de hoja mientras
 * teclea, ni para que el servidor valide lo que recibe sin salir a la red.
 *
 * De ahí que esto sea síncrono y no toque el puerto: recorre el libro, apoya
 * el análisis en el mismo tokenizador que usa la evaluación, y devuelve un
 * diagnóstico por celda con problema.
 */

import { analyzeExpression } from "./evaluate.js";
import { buildGraph, getRecalcOrder } from "./depGraph.js";
import { isFormulaContent } from "./graphicDirective.js";
import { isKnownFunction } from "./functions.js";
import { splitRef } from "./sheetRef.js";
import type { CustomFunctionDefinition } from "./customFunctions.js";
import type { SheetCells } from "./evaluateSheet.js";

/** Qué clase de problema tiene una celda. */
export type DiagnosticCode =
  | "syntax"
  | "unknown-sheet"
  | "unknown-function"
  | "argument-count"
  | "circular";

export interface SheetDiagnostic {
  /** Referencia canónica de la celda: `A1` o `Hoja1!A1`. */
  cell: string;
  code: DiagnosticCode;
  /** Motivo legible, para mostrárselo a quien escribe la plantilla. */
  message: string;
}

export interface AnalyzeSheetOptions {
  /** Funciones personalizadas disponibles para estas celdas. */
  customFunctions?: readonly CustomFunctionDefinition[];
}

/**
 * Hojas del libro, deducidas de las claves de las celdas.
 *
 * Igual que en `evaluateSheet`: con ellas, una referencia a una hoja que no
 * existe se puede señalar como error en vez de valer cero en silencio.
 */
const knownSheetsOf = (cells: SheetCells): Set<string> => {
  const sheets = new Set<string>();
  for (const ref of Object.keys(cells)) {
    const { sheet } = splitRef(ref);
    if (sheet !== undefined) sheets.add(sheet);
  }
  return sheets;
};

/**
 * Analiza un libro y devuelve un diagnóstico por cada problema encontrado.
 *
 * No evalúa ninguna fórmula, no invoca el puerto de funciones personalizadas
 * y no realiza ninguna operación asíncrona.
 */
export const analyzeSheet = (
  cells: SheetCells,
  options: AnalyzeSheetOptions = {},
): SheetDiagnostic[] => {
  const diagnostics: SheetDiagnostic[] = [];
  const knownSheets = knownSheetsOf(cells);

  const customArity = new Map<string, number>();
  for (const definition of options.customFunctions ?? []) {
    customArity.set(definition.code.toUpperCase(), definition.variables.length);
  }

  for (const ref of Object.keys(cells)) {
    const content = cells[ref]?.formula;
    // Los literales y las celdas de gráfico no se analizan como fórmulas: la
    // directiva del gráfico la valida quien conoce su sintaxis, no el motor.
    if (!isFormulaContent(content)) continue;

    const analysis = analyzeExpression(String(content).trim().slice(1));

    if (analysis.error !== undefined) {
      diagnostics.push({
        cell: ref,
        code: "syntax",
        message: analysis.error,
      });
      continue;
    }

    for (const referenced of analysis.refs) {
      const { sheet } = splitRef(referenced);
      if (sheet !== undefined && !knownSheets.has(sheet)) {
        diagnostics.push({
          cell: ref,
          code: "unknown-sheet",
          message: `La hoja "${sheet}" no existe en la plantilla`,
        });
      }
    }

    for (const call of analysis.calls) {
      const arity = customArity.get(call.name);

      if (arity === undefined) {
        if (!isKnownFunction(call.name)) {
          diagnostics.push({
            cell: ref,
            code: "unknown-function",
            message: `La función "${call.name}" no existe`,
          });
        }
        continue;
      }

      if (call.argCount !== arity) {
        diagnostics.push({
          cell: ref,
          code: "argument-count",
          message: `"${call.name}" espera ${arity} argumento(s) y recibe ${call.argCount}`,
        });
      }
    }
  }

  // Los ciclos no se ven celda a celda: salen del grafo del libro entero.
  const { circular } = getRecalcOrder(buildGraph(cells), Object.keys(cells));
  for (const ref of circular) {
    diagnostics.push({
      cell: ref,
      code: "circular",
      message: "La celda forma parte de una referencia circular",
    });
  }

  return diagnostics;
};
