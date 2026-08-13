import { describe, expect, it } from "vitest";
import { evaluateFormula, FORMULA_ERROR, type CellValueMap } from "./evaluate.js";

const KIT_EMBLE_CELLS: CellValueMap = {
  A3: "1CA",
  B3: "TPI",
  F3: "F-1CA-TPI-KIT EMBLE-GY-GENERICO-AD-AZ",
  O3: 100,
  P3: 9.87,
  P4: 0.72,
  P5: 2.91,
  P6: 13.5,
  P7: 0.05,
};

describe("evaluateFormula", () => {
  it("evaluates a plain numeric literal", () => {
    expect(evaluateFormula("100", {})).toBe(100);
  });

  it("passes through plain text", () => {
    expect(evaluateFormula("KIT EMBLE", {})).toBe("KIT EMBLE");
  });

  it("evaluates an arithmetic formula between cells", () => {
    // =P3/O3 with O3=100, P3=9.87
    expect(evaluateFormula("=P3/O3", KIT_EMBLE_CELLS)).toBeCloseTo(0.0987, 6);
  });

  it("evaluates concatenation of literals and cell references", () => {
    // ="F-"&A3&"-"&B3 with A3=1CA, B3=TPI
    expect(evaluateFormula('="F-"&A3&"-"&B3', KIT_EMBLE_CELLS)).toBe("F-1CA-TPI");
  });

  it("evaluates the LARGO function over a cell reference", () => {
    // =LARGO(F3)
    expect(evaluateFormula("=LARGO(F3)", KIT_EMBLE_CELLS)).toBe(37);
  });

  it("evaluates SUMA over a range", () => {
    // =SUMA(P3:P7)
    const expected = 9.87 + 0.72 + 2.91 + 13.5 + 0.05;
    expect(evaluateFormula("=SUMA(P3:P7)", KIT_EMBLE_CELLS)).toBeCloseTo(expected, 6);
  });

  it("supports nested arithmetic and precedence", () => {
    expect(evaluateFormula("=P3/O3*2", KIT_EMBLE_CELLS)).toBeCloseTo(0.1974, 6);
    expect(evaluateFormula("=2+3*4", {})).toBe(14);
    expect(evaluateFormula("=(2+3)*4", {})).toBe(20);
    expect(evaluateFormula("=2^3", {})).toBe(8);
  });

  it("treats a missing cell reference as 0", () => {
    expect(evaluateFormula("=Z99+1", {})).toBe(1);
  });

  it("supports unary minus", () => {
    expect(evaluateFormula("=-P3+O3", KIT_EMBLE_CELLS)).toBeCloseTo(90.13, 6);
  });

  it("supports comparators", () => {
    expect(evaluateFormula("=O3>P3", KIT_EMBLE_CELLS)).toBe(1);
    expect(evaluateFormula("=O3<P3", KIT_EMBLE_CELLS)).toBe(0);
  });

  it("returns #ERROR for an incomplete expression", () => {
    // =P3/
    expect(evaluateFormula("=P3/", KIT_EMBLE_CELLS)).toBe(FORMULA_ERROR);
  });

  it("returns #ERROR for a division by zero", () => {
    expect(evaluateFormula("=1/0", {})).toBe(FORMULA_ERROR);
  });

  it("returns #ERROR instead of executing arbitrary code", () => {
    // =fetch("...") must not be executed — `fetch` is just an unknown function name
    expect(evaluateFormula('=fetch("https://example.com")', {})).toBe(FORMULA_ERROR);
  });

  it("returns #ERROR for unbalanced parentheses", () => {
    expect(evaluateFormula("=SUMA(P3:P7", KIT_EMBLE_CELLS)).toBe(FORMULA_ERROR);
    expect(evaluateFormula("=(2+3))", {})).toBe(FORMULA_ERROR);
  });

  it("returns an empty string for an empty cell", () => {
    expect(evaluateFormula("", {})).toBe("");
    expect(evaluateFormula(undefined, {})).toBe("");
    expect(evaluateFormula(null, {})).toBe("");
  });
});
