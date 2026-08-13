import { describe, expect, it } from "vitest";
import {
  columnIndexToLabel,
  columnLabelToIndex,
  expandRange,
  isCellRef,
  isRangeRef,
  parseCellRef,
  positionToCellRef,
} from "./cellRef.js";

describe("cellRef", () => {
  it("converts column labels to indexes and back", () => {
    expect(columnLabelToIndex("A")).toBe(0);
    expect(columnLabelToIndex("Z")).toBe(25);
    expect(columnLabelToIndex("AA")).toBe(26);
    expect(columnIndexToLabel(0)).toBe("A");
    expect(columnIndexToLabel(25)).toBe("Z");
    expect(columnIndexToLabel(26)).toBe("AA");
  });

  it("parses A1 notation into a position", () => {
    expect(parseCellRef("A1")).toEqual({ row: 0, col: 0 });
    expect(parseCellRef("P3")).toEqual({ row: 2, col: 15 });
    expect(parseCellRef("$P$3")).toEqual({ row: 2, col: 15 });
  });

  it("returns null for invalid references", () => {
    expect(parseCellRef("not a ref")).toBeNull();
    expect(parseCellRef("1A")).toBeNull();
  });

  it("formats a position back into A1 notation", () => {
    expect(positionToCellRef({ row: 2, col: 15 })).toBe("P3");
  });

  it("identifies cell and range references", () => {
    expect(isCellRef("P3")).toBe(true);
    expect(isCellRef("P3:P10")).toBe(false);
    expect(isRangeRef("P3:P10")).toBe(true);
    expect(isRangeRef("P3")).toBe(false);
  });

  it("expands a range in row-major order", () => {
    expect(expandRange("A1:B2")).toEqual(["A1", "B1", "A2", "B2"]);
  });

  it("expands a single-column range", () => {
    expect(expandRange("P3:P7")).toEqual(["P3", "P4", "P5", "P6", "P7"]);
  });

  it("expands a range regardless of corner order", () => {
    expect(expandRange("B2:A1")).toEqual(["A1", "B1", "A2", "B2"]);
  });

  it("returns an empty array for an invalid range", () => {
    expect(expandRange("not a range")).toEqual([]);
  });
});
