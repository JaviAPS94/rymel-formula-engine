import { describe, expect, it, vi } from "vitest";
import { evaluateSheet } from "./evaluateSheet.js";
import { findCollidingCodes, type CustomFunctionCall } from "./customFunctions.js";
import { FORMULA_BAD_ARGS, FORMULA_CIRCULAR, FORMULA_ERROR } from "./evaluate.js";

const QUADRATIC = { id: 10, code: "QUADRATIC", variables: ["x"] };
const CUBIC = { id: 16, code: "CUBIC", variables: ["x", "b"] };
const COST = { id: 17, code: "COST", variables: ["x"] };
const ASSOCIATE_COST = { id: 18, code: "ASSOCIATE_COST", variables: ["x", "b"] };

/** Resolutor de prueba: cuadrado, cúbica y costos, contando las llamadas. */
const makeResolver = (compute: (call: CustomFunctionCall) => number) =>
  vi.fn(async (calls: CustomFunctionCall[]) =>
    calls.map((call) => ({ value: compute(call) })),
  );

describe("evaluateSheet: agrupación por nivel de dependencia", () => {
  it("resuelve muchas celdas independientes en un solo lote", async () => {
    // El escenario que motiva todo el diseño: hoy project-front haría 40
    // peticiones de red para esto.
    const cells: Record<string, { formula: string }> = {};
    for (let row = 1; row <= 40; row++) {
      cells[`A${row}`] = { formula: String(row) };
      cells[`B${row}`] = { formula: `=QUADRATIC(A${row})` };
    }

    const resolve = makeResolver((call) => call.parameters.x ** 2);
    const result = await evaluateSheet(cells, {
      customFunctions: [QUADRATIC],
      resolveCustomFunctions: resolve,
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toHaveLength(40);
    expect(result.batchCount).toBe(1);
    expect(result.values.B1).toBe(1);
    expect(result.values.B7).toBe(49);
    expect(result.values.B40).toBe(1600);
  });

  it("usa un lote por nivel cuando las funciones están encadenadas", async () => {
    const cells = {
      A1: { formula: "3" },
      A2: { formula: "2" },
      B1: { formula: "=QUADRATIC(A1)" },
      C1: { formula: "=CUBIC(B1, A2)" },
    };

    const resolve = makeResolver((call) =>
      call.definition.code === "QUADRATIC"
        ? call.parameters.x ** 2
        : call.parameters.x + call.parameters.b,
    );

    const result = await evaluateSheet(cells, {
      customFunctions: [QUADRATIC, CUBIC],
      resolveCustomFunctions: resolve,
    });

    expect(result.values.B1).toBe(9);
    expect(result.values.C1).toBe(11);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("resuelve funciones anidadas dentro de una misma celda", async () => {
    const cells = {
      A1: { formula: "3" },
      A2: { formula: "2" },
      B1: { formula: "=CUBIC(QUADRATIC(A1), A2)" },
    };

    const resolve = makeResolver((call) =>
      call.definition.code === "QUADRATIC"
        ? call.parameters.x ** 2
        : call.parameters.x + call.parameters.b,
    );

    const result = await evaluateSheet(cells, {
      customFunctions: [QUADRATIC, CUBIC],
      resolveCustomFunctions: resolve,
    });

    expect(result.values.B1).toBe(11);
  });

  it("combina el resultado con el resto de la expresión", async () => {
    const cells = { A1: { formula: "5" }, B1: { formula: "=QUADRATIC(A1) * 2 + 1" } };
    const resolve = makeResolver((call) => call.parameters.x ** 2);

    const result = await evaluateSheet(cells, {
      customFunctions: [QUADRATIC],
      resolveCustomFunctions: resolve,
    });

    expect(result.values.B1).toBe(51);
  });
});

describe("evaluateSheet: resolución del código de función", () => {
  it("no deja que un código capture dentro de otro más largo", async () => {
    // El bug vivo en producción: COST y ASSOCIATE_COST conviven en el mismo
    // subtipo, y el resolutor por expresión regular de project-front evalúa
    // `=ASSOCIATE_COST(...)` como COST.
    const cells = { A1: { formula: "4" }, A2: { formula: "3" }, B1: { formula: "=ASSOCIATE_COST(A1, A2)" } };

    const resolve = makeResolver((call) =>
      call.definition.code === "COST" ? -1 : call.parameters.x * call.parameters.b,
    );

    const result = await evaluateSheet(cells, {
      customFunctions: [COST, ASSOCIATE_COST],
      resolveCustomFunctions: resolve,
    });

    expect(resolve.mock.calls[0][0][0].definition.code).toBe("ASSOCIATE_COST");
    expect(result.values.B1).toBe(12);
  });

  it("no interpreta un código que aparece dentro de un literal de texto", async () => {
    const cells = { A1: { formula: "7" }, B1: { formula: '="El COST(total) es: " & A1' } };
    const resolve = makeResolver(() => -1);

    const result = await evaluateSheet(cells, {
      customFunctions: [COST],
      resolveCustomFunctions: resolve,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(result.values.B1).toBe("El COST(total) es: 7");
  });

  it("detecta los códigos que colisionan por sufijo", () => {
    expect(findCollidingCodes([COST, ASSOCIATE_COST])).toEqual([["COST", "ASSOCIATE_COST"]]);
    expect(findCollidingCodes([QUADRATIC, CUBIC])).toEqual([]);
  });

  it("detecta los códigos duplicados", () => {
    expect(findCollidingCodes([CUBIC, { ...CUBIC, id: 6 }])).toEqual([["CUBIC", "CUBIC"]]);
  });
});

describe("evaluateSheet: argumentos", () => {
  it("asocia los argumentos posicionales a las variables declaradas", async () => {
    const cells = { A1: { formula: "4" }, A2: { formula: "9" }, B1: { formula: "=CUBIC(A1, A2)" } };
    const resolve = makeResolver(() => 0);

    await evaluateSheet(cells, {
      customFunctions: [CUBIC],
      resolveCustomFunctions: resolve,
    });

    // El orden de `variables` es contrato: x recibe el primer argumento.
    expect(resolve.mock.calls[0][0][0].parameters).toEqual({ x: 4, b: 9 });
  });

  it("da error de argumentos sin invocar al puerto cuando falta uno", async () => {
    const cells = { A1: { formula: "4" }, B1: { formula: "=CUBIC(A1)" } };
    const resolve = makeResolver(() => 0);

    const result = await evaluateSheet(cells, {
      customFunctions: [CUBIC],
      resolveCustomFunctions: resolve,
    });

    expect(result.values.B1).toBe(FORMULA_BAD_ARGS);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("da error de argumentos cuando sobran", async () => {
    const cells = { A1: { formula: "4" }, B1: { formula: "=QUADRATIC(A1, A1)" } };
    const resolve = makeResolver(() => 0);

    const result = await evaluateSheet(cells, {
      customFunctions: [QUADRATIC],
      resolveCustomFunctions: resolve,
    });

    expect(result.values.B1).toBe(FORMULA_BAD_ARGS);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("evaluateSheet: fallos", () => {
  it("acota el fallo del puerto a las celdas de su lote", async () => {
    const cells = {
      A1: { formula: "5" },
      B1: { formula: "=A1 * 2" },
      C1: { formula: "=QUADRATIC(A1)" },
    };

    const resolve = vi.fn(async () => {
      throw new Error("el motor cifrado no responde");
    });

    const result = await evaluateSheet(cells, {
      customFunctions: [QUADRATIC],
      resolveCustomFunctions: resolve,
    });

    expect(result.values.C1).toBe(FORMULA_ERROR);
    expect(result.values.B1).toBe(10); // no depende del lote: conserva su valor
  });

  it("marca la celda en error cuando el puerto devuelve error", async () => {
    const cells = { A1: { formula: "5" }, B1: { formula: "=QUADRATIC(A1)" } };
    const resolve = vi.fn(async () => [{ error: "división por cero" }]);

    const result = await evaluateSheet(cells, {
      customFunctions: [QUADRATIC],
      resolveCustomFunctions: resolve,
    });

    expect(result.values.B1).toBe(FORMULA_ERROR);
  });

  it("da error si se invoca una función personalizada sin puerto que la resuelva", async () => {
    const cells = { A1: { formula: "5" }, B1: { formula: "=QUADRATIC(A1)" } };

    const result = await evaluateSheet(cells, { customFunctions: [QUADRATIC] });

    expect(result.values.B1).toBe(FORMULA_ERROR);
  });

  it("marca las celdas de una referencia circular y calcula el resto", async () => {
    const cells = {
      A1: { formula: "=B1+1" },
      B1: { formula: "=A1+1" },
      C1: { formula: "=2*3" },
    };

    const result = await evaluateSheet(cells);

    expect(result.circular).toEqual(new Set(["A1", "B1"]));
    expect(result.values.A1).toBe(FORMULA_CIRCULAR);
    expect(result.values.C1).toBe(6);
  });
});

describe("evaluateSheet: varias hojas", () => {
  it("resuelve dependencias entre hojas en el orden correcto", async () => {
    const cells = {
      "Template 1F!A11": { formula: "5" },
      "Hoja2!B2": { formula: "='Template 1F'!A11 * 2" },
      "Hoja2!B3": { formula: "=B2 + 1" },
    };

    const result = await evaluateSheet(cells);

    expect(result.values["Hoja2!B2"]).toBe(10);
    expect(result.values["Hoja2!B3"]).toBe(11);
  });

  it("da error al referenciar una hoja que no existe, sin frenar el resto", async () => {
    const cells = {
      "Hoja1!A1": { formula: "5" },
      "Hoja1!B1": { formula: "=NoExiste!A1" },
      "Hoja1!C1": { formula: "=A1 * 2" },
    };

    const result = await evaluateSheet(cells);

    expect(result.values["Hoja1!B1"]).toBe(FORMULA_ERROR);
    expect(result.values["Hoja1!C1"]).toBe(10);
  });

  it("recalcula la otra hoja cuando cambia la celda referenciada", async () => {
    const cells = {
      "Template 1F!A11": { formula: "8" },
      "Hoja2!B2": { formula: "='Template 1F'!A11 * 2" },
    };

    const result = await evaluateSheet(cells, {
      dirtyCells: ["Template 1F!A11"],
    });

    expect(result.values["Hoja2!B2"]).toBe(16);
  });
});
