import { describe, expect, it } from "vitest";
import { callFunction, FormulaError, isKnownFunction } from "./functions.js";

describe("functions", () => {
  it("recognizes both the Spanish and English names of each function", () => {
    expect(isKnownFunction("SUMA")).toBe(true);
    expect(isKnownFunction("SUM")).toBe(true);
    expect(isKnownFunction("largo")).toBe(true);
    expect(isKnownFunction("fetch")).toBe(false);
  });

  it("SUMA/SUM adds numbers and flattens ranges", () => {
    expect(callFunction("SUMA", [1, 2, [3, 4]])).toBe(10);
    expect(callFunction("SUM", [1, 2, [3, 4]])).toBe(10);
  });

  it("PROMEDIO/AVERAGE averages numbers and flattens ranges", () => {
    expect(callFunction("PROMEDIO", [[2, 4, 6]])).toBe(4);
    expect(callFunction("AVERAGE", [])).toBe(0);
  });

  it("LARGO/LEN returns the length of a text value", () => {
    expect(callFunction("LARGO", ["F-1CA-TPI-KIT EMBLE-GY-GENERICO-AD-AZ"])).toBe(37);
    expect(callFunction("LEN", [123])).toBe(3);
  });

  it("SI/IF returns the branch for the condition", () => {
    expect(callFunction("SI", [1, "yes", "no"])).toBe("yes");
    expect(callFunction("IF", [0, "yes", "no"])).toBe("no");
  });

  it("REDONDEAR/ROUND rounds to the given decimals", () => {
    expect(callFunction("REDONDEAR", [0.09865, 4])).toBe(0.0987);
    expect(callFunction("ROUND", [9.87, 0])).toBe(10);
  });

  it("CONCATENAR/CONCAT joins its arguments as text", () => {
    expect(callFunction("CONCATENAR", ["F-", "1CA", "-", "TPI"])).toBe("F-1CA-TPI");
  });

  it("IZQUIERDA/LEFT and DERECHA/RIGHT slice text", () => {
    expect(callFunction("IZQUIERDA", ["KIT EMBLE", 3])).toBe("KIT");
    expect(callFunction("RIGHT", ["KIT EMBLE", 5])).toBe("EMBLE");
  });

  it("throws FormulaError for an unknown function", () => {
    expect(() => callFunction("FETCH", ["http://example.com"])).toThrow(FormulaError);
  });

  it("throws FormulaError when arguments are the wrong count or type", () => {
    expect(() => callFunction("LARGO", [])).toThrow(FormulaError);
    expect(() => callFunction("REDONDEAR", ["abc", 2])).toThrow(FormulaError);
  });
});
