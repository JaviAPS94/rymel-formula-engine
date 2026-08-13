/**
 * Dependency graph between grid cells: precedents (what a cell reads from)
 * and dependents (what reads from a cell), plus topological recalculation
 * order.
 *
 * Ported from `project-front/src/hooks/useDepGraph.ts` as plain TypeScript
 * (no React): that version wrapped this same logic in a `useRef` because it
 * doesn't need to trigger renders — the caller here owns storage instead.
 *
 * Cross-sheet references (`Sheet1!A1`) are not handled yet: references are
 * resolved within a single sheet. Support for them lands with the shared
 * engine's cross-sheet requirement.
 */

/** Matches a single cell reference: `A1`, `$A$1` */
const CELL_REF_REGEX = /\$?[A-Z]+\$?\d+/g;

/** Matches a range reference to expand into individual cells: `A1:B5` */
const RANGE_REF_REGEX = /\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/g;

const columnLabelToIndex = (label: string): number => {
  let index = 0;
  for (let i = 0; i < label.length; i++) {
    index = index * 26 + (label.charCodeAt(i) - 64);
  }
  return index - 1;
};

const columnIndexToLabel = (col: number): string => {
  let label = "";
  let num = col + 1;
  while (num > 0) {
    const remainder = (num - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    num = Math.floor((num - 1) / 26);
  }
  return label;
};

/**
 * Extracts every cell reference a formula depends on (its precedents),
 * expanding ranges into individual cells. Returns normalized refs like
 * `A1`, with `$` stripped.
 */
export const extractPrecedents = (formula: string): Set<string> => {
  if (!formula || !formula.startsWith("=")) return new Set();

  const refs = new Set<string>();
  const expr = formula.slice(1);

  const rangeRegex = new RegExp(RANGE_REF_REGEX.source, "g");
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = rangeRegex.exec(expr)) !== null) {
    const startCol = columnLabelToIndex(rangeMatch[1]);
    const startRow = Number.parseInt(rangeMatch[2], 10) - 1;
    const endCol = columnLabelToIndex(rangeMatch[3]);
    const endRow = Number.parseInt(rangeMatch[4], 10) - 1;

    for (
      let row = Math.min(startRow, endRow);
      row <= Math.max(startRow, endRow);
      row++
    ) {
      for (
        let col = Math.min(startCol, endCol);
        col <= Math.max(startCol, endCol);
        col++
      ) {
        refs.add(`${columnIndexToLabel(col)}${row + 1}`);
      }
    }
  }

  const refRegex = new RegExp(CELL_REF_REGEX.source, "g");
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refRegex.exec(expr)) !== null) {
    refs.add(refMatch[0].replace(/\$/g, ""));
  }

  return refs;
};

export interface DepGraph {
  /** cellRef -> set of cells it depends on */
  precedents: Map<string, Set<string>>;
  /** cellRef -> set of cells that depend on it */
  dependents: Map<string, Set<string>>;
}

export const createDepGraph = (): DepGraph => ({
  precedents: new Map(),
  dependents: new Map(),
});

/** Rebuilds the entire graph from scratch for a given set of cell formulas. */
export const buildGraph = (
  cells: Record<string, { formula?: string } | undefined>,
): DepGraph => {
  const graph = createDepGraph();

  for (const cellRef of Object.keys(cells)) {
    const formula = cells[cellRef]?.formula;
    if (!formula?.startsWith("=")) continue;

    const precedents = extractPrecedents(formula);
    graph.precedents.set(cellRef, precedents);

    precedents.forEach((precedentRef) => {
      if (!graph.dependents.has(precedentRef)) {
        graph.dependents.set(precedentRef, new Set());
      }
      graph.dependents.get(precedentRef)!.add(cellRef);
    });
  }

  return graph;
};

/**
 * Incrementally updates the graph when a single cell's formula changes.
 * Mutates `graph` in place.
 */
export const updateCellInGraph = (
  graph: DepGraph,
  cellRef: string,
  newFormula: string,
): void => {
  const { precedents, dependents } = graph;

  const oldPrecedents = precedents.get(cellRef);
  if (oldPrecedents) {
    oldPrecedents.forEach((oldPrecedentRef) => {
      dependents.get(oldPrecedentRef)?.delete(cellRef);
    });
  }

  const newPrecedents = extractPrecedents(newFormula);

  if (newPrecedents.size > 0) {
    precedents.set(cellRef, newPrecedents);
    newPrecedents.forEach((precedentRef) => {
      if (!dependents.has(precedentRef)) dependents.set(precedentRef, new Set());
      dependents.get(precedentRef)!.add(cellRef);
    });
  } else {
    precedents.delete(cellRef);
  }
};

export interface RecalcOrder {
  /** Cells to recalculate, dependencies first */
  order: string[];
  /** Cells that couldn't be ordered because they're part of a cycle */
  circular: Set<string>;
}

/**
 * Given a set of "dirty" cells, returns all cells that need recalculation
 * (the dirty cells plus their transitive dependents) in topological order.
 * Cells that belong to a circular reference are reported separately instead
 * of being recursed into.
 */
export const getRecalcOrder = (
  graph: DepGraph,
  dirtyCells: string[],
): RecalcOrder => {
  const { dependents, precedents } = graph;

  // 1) Collect all affected cells: dirty + transitive dependents
  const affected = new Set<string>();
  const queue = [...dirtyCells];
  while (queue.length > 0) {
    const cell = queue.shift()!;
    if (affected.has(cell)) continue;
    affected.add(cell);

    dependents.get(cell)?.forEach((dependent) => {
      if (!affected.has(dependent)) queue.push(dependent);
    });
  }

  // 2) Topological sort (Kahn's algorithm) over the affected subgraph
  const inDegree = new Map<string, number>();
  affected.forEach((cell) => inDegree.set(cell, 0));
  affected.forEach((cell) => {
    let count = 0;
    precedents.get(cell)?.forEach((precedentRef) => {
      if (affected.has(precedentRef)) count++;
    });
    inDegree.set(cell, count);
  });

  const order: string[] = [];
  const zeroQueue: string[] = [];
  inDegree.forEach((degree, cell) => {
    if (degree === 0) zeroQueue.push(cell);
  });

  while (zeroQueue.length > 0) {
    const cell = zeroQueue.shift()!;
    order.push(cell);

    dependents.get(cell)?.forEach((dependent) => {
      if (!affected.has(dependent)) return;
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) zeroQueue.push(dependent);
    });
  }

  // 3) Any affected cell not in `order` is part of a cycle
  const orderedSet = new Set(order);
  const circular = new Set<string>();
  affected.forEach((cell) => {
    if (!orderedSet.has(cell)) circular.add(cell);
  });

  // The dirty cells themselves are plain inputs (already have their new
  // value) unless they also carry a formula; only cells with a formula
  // need to be re-evaluated, so the output is filtered to those.
  return { order: order.filter((cell) => precedents.has(cell)), circular };
};

/**
 * Checks, without mutating the graph, whether assigning `newFormula` to
 * `cellRef` would create a circular reference.
 */
export const wouldCreateCycle = (
  graph: DepGraph,
  cellRef: string,
  newFormula: string,
): boolean => {
  const newPrecedents = extractPrecedents(newFormula);
  if (newPrecedents.size === 0) return false;

  const visited = new Set<string>();
  const stack = [...newPrecedents];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === cellRef) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    graph.precedents.get(current)?.forEach((precedentRef) => {
      if (!visited.has(precedentRef)) stack.push(precedentRef);
    });
  }

  return false;
};
