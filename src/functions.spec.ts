import { describe, expect, it } from "vitest";
import {
  callFunction,
  FormulaError,
  isKnownFunction,
  type FormulaArg,
} from "./functions.js";

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

describe("paridad con el evaluador de project-front", () => {
  // project-front traduce estos nombres a `Math.*` y evalúa con Function().
  // Si el motor no los soporta, adoptarlo allí convertiría en error cualquier
  // hoja que los use.
  const casos: Array<[string, FormulaArg[], number]> = [
    ["SENO", [0], 0],
    ["SIN", [0], 0],
    ["COSENO", [0], 1],
    ["TANGENTE", [0], 0],
    ["ASENO", [1], Math.PI / 2],
    ["ACOSENO", [1], 0],
    ["ATAN", [1], Math.PI / 4],
    ["LOGARITMO", [100], 2],
    ["LOG", [1000], 3],
    ["LN", [Math.E], 1],
    ["RAIZ", [9], 3],
    ["SQRT", [16], 4],
    ["ABS", [-7], 7],
    ["TECHO", [2.1], 3],
    ["CEILING", [2.1], 3],
    ["PISO", [2.9], 2],
    ["FLOOR", [2.9], 2],
    ["RADIANES", [180], Math.PI],
    ["GRADOS", [Math.PI], 180],
  ];

  it.each(casos)("%s(%s) = %s", (name, args, expected) => {
    expect(callFunction(name, args)).toBeCloseTo(expected, 10);
  });

  it("POTENCIA y POWER elevan", () => {
    expect(callFunction("POTENCIA", [2, 10])).toBe(1024);
    expect(callFunction("POWER", [3, 3])).toBe(27);
  });

  it("PI() no lleva argumentos", () => {
    expect(callFunction("PI", [])).toBeCloseTo(Math.PI, 12);
    expect(() => callFunction("PI", [1])).toThrow(FormulaError);
  });

  it("Y y O evalúan lógica", () => {
    expect(callFunction("Y", [1, 1])).toBe(1);
    expect(callFunction("Y", [1, 0])).toBe(0);
    expect(callFunction("AND", [1, 1])).toBe(1);
    expect(callFunction("O", [0, 1])).toBe(1);
    expect(callFunction("OR", [0, 0])).toBe(0);
  });

  it("un resultado no finito es error, no NaN ni Infinity", () => {
    // project-front devolvería NaN aquí y lo convertiría en #ERROR; el motor
    // lo corta antes, para que un NaN no se propague como si fuera un dato.
    expect(() => callFunction("RAIZ", [-1])).toThrow(FormulaError);
    expect(() => callFunction("LN", [0])).toThrow(FormulaError);
  });
});
