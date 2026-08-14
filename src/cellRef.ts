/**
 * Cell reference utilities: `A1` <-> `{row, col}` conversion, column
 * letter labels, and range expansion (`P3:P10`).
 *
 * `row` and `col` are 0-based internally; `A1` notation is 1-based for
 * rows and letter-based for columns, matching spreadsheet convention.
 */

export interface CellPosition {
  row: number;
  col: number;
}

const CELL_REF_PATTERN = /^\$?([A-Z]+)\$?(\d+)$/;
const RANGE_PATTERN = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/;

/** `A` -> 0, `B` -> 1, ..., `Z` -> 25, `AA` -> 26 */
export const columnLabelToIndex = (label: string): number => {
  let index = 0;
  for (let i = 0; i < label.length; i++) {
    index = index * 26 + (label.charCodeAt(i) - 64);
  }
  return index - 1;
};

/** 0 -> `A`, 1 -> `B`, ..., 25 -> `Z`, 26 -> `AA` */
export const columnIndexToLabel = (index: number): string => {
  let label = "";
  let num = index + 1;
  while (num > 0) {
    const remainder = (num - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    num = Math.floor((num - 1) / 26);
  }
  return label;
};

/** Formats a `{row, col}` position as `A1` notation */
export const positionToCellRef = (position: CellPosition): string =>
  `${columnIndexToLabel(position.col)}${position.row + 1}`;

/** Parses `A1` notation into a `{row, col}` position, or `null` if invalid */
export const parseCellRef = (ref: string): CellPosition | null => {
  const match = CELL_REF_PATTERN.exec(ref.trim());
  if (!match) return null;
  return {
    col: columnLabelToIndex(match[1]),
    row: Number.parseInt(match[2], 10) - 1,
  };
};

/** `true` if `token` is a single cell reference like `A1` or `$A$1` */
export const isCellRef = (token: string): boolean =>
  CELL_REF_PATTERN.test(token.trim());

/** `true` if `token` is a range reference like `A1:B5` */
export const isRangeRef = (token: string): boolean =>
  RANGE_PATTERN.test(token.trim());

/**
 * Expande un rango conservando su forma de tabla: una fila por cada fila del
 * rango. `A1:B3` produce `[[A1,B1],[A2,B2],[A3,B3]]`.
 *
 * `BUSCARV` y `COINCIDIR` necesitan saber qué celda está en qué columna, y
 * eso se pierde al aplanar.
 */
export const expandRangeToGrid = (range: string): string[][] => {
  const match = RANGE_PATTERN.exec(range.trim());
  if (!match) return [];

  const startCol = columnLabelToIndex(match[1]);
  const startRow = Number.parseInt(match[2], 10) - 1;
  const endCol = columnLabelToIndex(match[3]);
  const endRow = Number.parseInt(match[4], 10) - 1;

  const rows: string[][] = [];
  for (
    let row = Math.min(startRow, endRow);
    row <= Math.max(startRow, endRow);
    row++
  ) {
    const cells: string[] = [];
    for (
      let col = Math.min(startCol, endCol);
      col <= Math.max(startCol, endCol);
      col++
    ) {
      cells.push(positionToCellRef({ row, col }));
    }
    rows.push(cells);
  }
  return rows;
};

/**
 * Expands a range reference (`A1:B3`) into its individual cell references,
 * in row-major order: `A1, B1, A2, B2, A3, B3`.
 *
 * Returns an empty array if `range` isn't a valid range.
 */
export const expandRange = (range: string): string[] => {
  const match = RANGE_PATTERN.exec(range.trim());
  if (!match) return [];

  const startCol = columnLabelToIndex(match[1]);
  const startRow = Number.parseInt(match[2], 10) - 1;
  const endCol = columnLabelToIndex(match[3]);
  const endRow = Number.parseInt(match[4], 10) - 1;

  const refs: string[] = [];
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
      refs.push(positionToCellRef({ row, col }));
    }
  }
  return refs;
};
