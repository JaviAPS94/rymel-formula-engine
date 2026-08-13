import { describe, expect, it } from "vitest";
import { isQualifiedRef, normalizeRef, parseQualifiedRef, splitRef } from "./sheetRef.js";
import { extractPrecedents } from "./depGraph.js";
import { evaluateFormula } from "./evaluate.js";

describe("parseQualifiedRef", () => {
  it("separa hoja y celda", () => {
    expect(parseQualifiedRef("Hoja1!A1")).toEqual({ sheet: "Hoja1", cell: "A1" });
  });

  it("admite nombres de hoja con espacios entre comillas", () => {
    expect(parseQualifiedRef("'Template 1F'!A11")).toEqual({
      sheet: "Template 1F",
      cell: "A11",
    });
  });

  it("normaliza la parte de celda quitando $ y pasando a mayúsculas", () => {
    expect(parseQualifiedRef("Hoja1!$a$1")).toEqual({ sheet: "Hoja1", cell: "A1" });
  });

  it("conserva el nombre de la hoja tal como lo escribió el usuario", () => {
    expect(parseQualifiedRef("'Template 1F'!A1")?.sheet).toBe("Template 1F");
  });

  it("admite rangos calificados", () => {
    expect(parseQualifiedRef("Hoja1!A1:B5")).toEqual({ sheet: "Hoja1", cell: "A1:B5" });
  });

  it("devuelve null para una referencia sin hoja", () => {
    expect(parseQualifiedRef("A1")).toBeNull();
    expect(isQualifiedRef("A1")).toBe(false);
  });
});

describe("normalizeRef", () => {
  it("califica una referencia local con la hoja actual", () => {
    expect(normalizeRef("A1", "Hoja2")).toBe("Hoja2!A1");
  });

  it("deja la referencia sin calificar cuando no hay hoja actual", () => {
    expect(normalizeRef("$a$1")).toBe("A1");
  });

  it("no vuelve a calificar una referencia que ya lleva hoja", () => {
    expect(normalizeRef("Hoja1!A1", "Hoja2")).toBe("Hoja1!A1");
  });
});

describe("splitRef", () => {
  it("separa una referencia canónica", () => {
    expect(splitRef("Template 1F!A11")).toEqual({ sheet: "Template 1F", cell: "A11" });
  });

  it("informa hoja indefinida cuando no la lleva", () => {
    expect(splitRef("A11")).toEqual({ cell: "A11" });
  });
});

describe("extractPrecedents con hojas", () => {
  it("extrae una referencia a otra hoja", () => {
    expect(extractPrecedents("='Template 1F'!A11 * 2", "Hoja2")).toEqual(
      new Set(["Template 1F!A11"]),
    );
  });

  it("no vuelve a contar la parte de celda de una referencia calificada", () => {
    // Si `Hoja1!A1` se contara además como `Hoja2!A1`, la celda dependería de
    // una celda de su propia hoja que la fórmula nunca menciona.
    expect(extractPrecedents("=Hoja1!A1", "Hoja2")).toEqual(new Set(["Hoja1!A1"]));
  });

  it("mezcla referencias locales y de otra hoja", () => {
    expect(extractPrecedents("=A1 + Hoja1!B2", "Hoja2")).toEqual(
      new Set(["Hoja2!A1", "Hoja1!B2"]),
    );
  });

  it("expande un rango calificado", () => {
    expect(extractPrecedents("=SUMA(Hoja1!A1:A3)", "Hoja2")).toEqual(
      new Set(["Hoja1!A1", "Hoja1!A2", "Hoja1!A3"]),
    );
  });

  it("ignora lo que aparece dentro de un literal de texto", () => {
    expect(extractPrecedents('="ver A1 y Hoja1!B2"', "Hoja2")).toEqual(new Set());
  });

  it("mantiene el comportamiento de una sola hoja cuando no se indica hoja", () => {
    expect(extractPrecedents("=A1+B2")).toEqual(new Set(["A1", "B2"]));
  });
});

describe("evaluación con referencias entre hojas", () => {
  it("resuelve una celda de otra hoja", () => {
    const values = { "Template 1F!A11": 5, "Hoja2!B2": 0 };
    expect(evaluateFormula("='Template 1F'!A11 * 2", values, { sheet: "Hoja2" })).toBe(10);
  });

  it("resuelve una referencia local contra la hoja actual", () => {
    const values = { "Hoja2!A1": 7, "Hoja1!A1": 99 };
    expect(evaluateFormula("=A1", values, { sheet: "Hoja2" })).toBe(7);
  });

  it("suma un rango de otra hoja", () => {
    const values = { "Hoja1!A1": 1, "Hoja1!A2": 2, "Hoja1!A3": 39 };
    expect(evaluateFormula("=SUMA(Hoja1!A1:A3)", values, { sheet: "Hoja2" })).toBe(42);
  });

  it("trata como cero la referencia a una hoja que no existe", () => {
    // Coherente con cómo trata este motor cualquier celda vacía: no
    // interrumpe el cálculo del resto de la hoja.
    expect(evaluateFormula("=NoExiste!A1", {}, { sheet: "Hoja2" })).toBe(0);
  });
});
