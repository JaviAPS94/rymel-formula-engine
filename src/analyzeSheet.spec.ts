import { describe, expect, it, vi } from "vitest";
import { analyzeSheet } from "./analyzeSheet.js";
import { PLANTILLA_1F } from "../test/fixtures/plantilla-1f.js";

const codigos = (cells: Parameters<typeof analyzeSheet>[0], opciones = {}) =>
  analyzeSheet(cells, opciones).map((d) => `${d.cell}:${d.code}`);

describe("analyzeSheet", () => {
  it("no devuelve nada para un libro correcto", () => {
    expect(
      analyzeSheet({
        A1: { formula: "10" },
        A2: { formula: "=SUMA(A1:A1)" },
      }),
    ).toEqual([]);
  });

  it("señala una fórmula mal escrita", () => {
    const [diagnostico] = analyzeSheet({ A1: { formula: "=SUMA(" } });

    expect(diagnostico.cell).toBe("A1");
    expect(diagnostico.code).toBe("syntax");
    expect(diagnostico.message).not.toBe("");
  });

  it("señala una referencia a una hoja que no existe", () => {
    const diagnosticos = analyzeSheet({
      "Hoja2!A1": { formula: "='Hoja9'!A1" },
    });

    expect(diagnosticos).toHaveLength(1);
    expect(diagnosticos[0]).toMatchObject({
      cell: "Hoja2!A1",
      code: "unknown-sheet",
    });
    expect(diagnosticos[0].message).toContain("Hoja9");
  });

  it("acepta una referencia a una hoja que sí existe", () => {
    expect(
      analyzeSheet({
        "Hoja1!A1": { formula: "5" },
        "Hoja2!A1": { formula: "=Hoja1!A1*2" },
      }),
    ).toEqual([]);
  });

  it("señala una función que no existe", () => {
    const diagnosticos = analyzeSheet({ A1: { formula: "=CUBIC(A2)" } });

    expect(diagnosticos).toHaveLength(1);
    expect(diagnosticos[0]).toMatchObject({ cell: "A1", code: "unknown-function" });
    expect(diagnosticos[0].message).toContain("CUBIC");
  });

  it("acepta una función personalizada declarada en el catálogo", () => {
    expect(
      analyzeSheet(
        { A1: { formula: "=CUBIC(A2)" }, A2: { formula: "3" } },
        { customFunctions: [{ code: "CUBIC", variables: ["x"] }] },
      ),
    ).toEqual([]);
  });

  it("señala una función personalizada con argumentos de más o de menos", () => {
    const diagnosticos = analyzeSheet(
      { A1: { formula: "=CUBIC(A2)" } },
      { customFunctions: [{ code: "CUBIC", variables: ["x", "b"] }] },
    );

    expect(diagnosticos).toHaveLength(1);
    expect(diagnosticos[0]).toMatchObject({ cell: "A1", code: "argument-count" });
    expect(diagnosticos[0].message).toContain("2");
  });

  it("no confunde un código con otro que lo contiene", () => {
    expect(
      analyzeSheet(
        { A1: { formula: "=ASSOCIATE_COST(A2,A3)" } },
        {
          customFunctions: [
            { code: "COST", variables: ["x"] },
            { code: "ASSOCIATE_COST", variables: ["x", "y"] },
          ],
        },
      ),
    ).toEqual([]);
  });

  it("señala todas las celdas de un ciclo, aunque cruce hojas", () => {
    const diagnosticos = codigos({
      "Hoja1!A1": { formula: "=Hoja2!B1+1" },
      "Hoja2!B1": { formula: "=Hoja1!A1+1" },
    });

    expect(diagnosticos.sort()).toEqual(["Hoja1!A1:circular", "Hoja2!B1:circular"]);
  });

  it("no analiza las celdas de gráfico como fórmulas", () => {
    expect(
      analyzeSheet({
        "Resumen!K73": { formula: "=DRAW:BOBINADO:D56:D59,D60,D61,D62" },
      }),
    ).toEqual([]);
  });

  it("no invoca el puerto de funciones personalizadas", () => {
    const puerto = vi.fn();

    analyzeSheet(
      { A1: { formula: "=CUBIC(A2)" }, A2: { formula: "3" } },
      {
        customFunctions: [{ code: "CUBIC", variables: ["x"] }],
        // El puerto no forma parte de las opciones del análisis: esta prueba
        // fija que no hay forma de que se llame ni por accidente.
        ...({ resolveCustomFunctions: puerto } as object),
      },
    );

    expect(puerto).not.toHaveBeenCalled();
  });

  it("es síncrono: devuelve un arreglo, no una promesa", () => {
    expect(analyzeSheet({ A1: { formula: "=1+1" } })).toBeInstanceOf(Array);
  });

  it("no encuentra ningún problema en la plantilla real", () => {
    // Sus fórmulas están escritas con `;`, con rangos calificados en ambos
    // extremos y con una celda de gráfico: si el análisis las marcara, el
    // editor rechazaría la única plantilla completa que existe.
    expect(analyzeSheet({ ...PLANTILLA_1F })).toEqual([]);
  });
});
