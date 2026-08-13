import { describe, expect, it } from "vitest";
import {
  buildGraph,
  extractPrecedents,
  getRecalcOrder,
  updateCellInGraph,
  wouldCreateCycle,
} from "./depGraph.js";
import { evaluateFormula, FORMULA_CIRCULAR, type CellValueMap } from "./evaluate.js";

describe("extractPrecedents", () => {
  it("extracts single cell references", () => {
    expect(extractPrecedents("=P3/O3")).toEqual(new Set(["P3", "O3"]));
  });

  it("expands range references into individual cells", () => {
    expect(extractPrecedents("=SUMA(P3:P5)")).toEqual(new Set(["P3", "P4", "P5"]));
  });

  it("returns an empty set for a non-formula value", () => {
    expect(extractPrecedents("100")).toEqual(new Set());
    expect(extractPrecedents("")).toEqual(new Set());
  });
});

describe("buildGraph / getRecalcOrder", () => {
  it("propagates in cascade: changing P3 recalculates Q3 then R3, and nothing else", () => {
    const graph = buildGraph({
      O3: {},
      P3: {},
      Q3: { formula: "=P3/O3" },
      R3: { formula: "=Q3*2" },
      Z9: { formula: "=1+1" },
    });

    const { order, circular } = getRecalcOrder(graph, ["P3"]);

    expect(order).toEqual(["Q3", "R3"]);
    expect(circular.size).toBe(0);
  });

  it("detects a circular reference and excludes it from the order", () => {
    const graph = buildGraph({
      Q3: { formula: "=R3" },
      R3: { formula: "=Q3" },
    });

    const { order, circular } = getRecalcOrder(graph, ["Q3"]);

    expect(order).toEqual([]);
    expect(circular).toEqual(new Set(["Q3", "R3"]));
  });

  it("marks cells in a cycle as #CIRCULAR instead of evaluating them", () => {
    const graph = buildGraph({
      Q3: { formula: "=R3" },
      R3: { formula: "=Q3" },
    });

    const { circular } = getRecalcOrder(graph, ["Q3"]);
    const results: CellValueMap = {};
    circular.forEach((cell) => {
      results[cell] = FORMULA_CIRCULAR;
    });

    expect(results.Q3).toBe(FORMULA_CIRCULAR);
    expect(results.R3).toBe(FORMULA_CIRCULAR);
  });

  it("end to end: recalculating in order yields the correct cascaded values", () => {
    const graph = buildGraph({
      O3: {},
      P3: {},
      Q3: { formula: "=P3/O3" },
      R3: { formula: "=Q3*2" },
    });
    const formulas: Record<string, string> = {
      Q3: "=P3/O3",
      R3: "=Q3*2",
    };

    const values: CellValueMap = { O3: 100, P3: 9.87 };
    const { order } = getRecalcOrder(graph, ["P3"]);

    order.forEach((cell) => {
      values[cell] = evaluateFormula(formulas[cell], values);
    });

    expect(values.Q3).toBeCloseTo(0.0987, 6);
    expect(values.R3).toBeCloseTo(0.1974, 6);
  });
});

describe("updateCellInGraph", () => {
  it("replaces a cell's precedents when its formula changes", () => {
    const graph = buildGraph({ A1: {}, B1: {}, C1: { formula: "=A1+1" } });

    updateCellInGraph(graph, "C1", "=B1+1");

    expect(graph.precedents.get("C1")).toEqual(new Set(["B1"]));
    expect(graph.dependents.get("A1")?.has("C1")).toBeFalsy();
    expect(graph.dependents.get("B1")?.has("C1")).toBe(true);
  });
});

describe("wouldCreateCycle", () => {
  it("detects a direct self-reference", () => {
    const graph = buildGraph({});
    expect(wouldCreateCycle(graph, "A1", "=A1+1")).toBe(true);
  });

  it("detects an indirect cycle through existing precedents", () => {
    const graph = buildGraph({ B1: { formula: "=A1" } });
    expect(wouldCreateCycle(graph, "A1", "=B1")).toBe(true);
  });

  it("returns false when there is no cycle", () => {
    const graph = buildGraph({ B1: { formula: "=A1" } });
    expect(wouldCreateCycle(graph, "C1", "=B1")).toBe(false);
  });
});
