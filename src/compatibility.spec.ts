/**
 * Compatibilidad con las plantillas reales.
 *
 * Estas pruebas no salieron de una lista de funcionalidades sino de ejecutar
 * el motor contra el volcado de la única plantilla completa que existe en la
 * base de datos: de sus 9 celdas con `=`, **3 daban `#ERROR`**. Como
 * project-front ya evalúa con este motor y recalcula la plantilla al
 * cargarla, eran defectos vivos, no hipótesis.
 *
 * El fixture `test/fixtures/plantilla-1f.ts` es el cierre transitivo de
 * esas celdas sobre el libro real: sus fórmulas y todo lo que referencian,
 * tal cual están guardadas.
 */

import { describe, expect, it } from "vitest";
import { PLANTILLA_1F } from "../test/fixtures/plantilla-1f.js";
import { evaluateFormula, FORMULA_ERROR } from "./evaluate.js";
import { evaluateSheet } from "./evaluateSheet.js";
import { buildGraph, extractPrecedents, getRecalcOrder } from "./depGraph.js";
import { graphicDirectiveValue, isGraphicDirective } from "./graphicDirective.js";

const libroReal = (): Record<string, { formula: string }> => ({ ...PLANTILLA_1F });

describe("separador de argumentos regional", () => {
  const valores = { G13: 1, G14: 3, B3: 1, C3: 5, B4: 2, C4: 7 };

  it("da el mismo resultado con `;` que con `,`", () => {
    const conComas = evaluateFormula("=G14*(BUSCARV(G13,B3:C10,2,VERDADERO))", valores);
    const conPuntoYComa = evaluateFormula(
      "=G14*(BUSCARV(G13;B3:C10;2;VERDADERO))",
      valores,
    );

    expect(conPuntoYComa).toBe(conComas);
    expect(conPuntoYComa).not.toBe(FORMULA_ERROR);
  });

  it("admite `;` en funciones de aridad variable", () => {
    expect(evaluateFormula("=SUMA(1;2;3)", {})).toBe(6);
    expect(evaluateFormula("=SUMA(1,2,3)", {})).toBe(6);
  });

  it("no confunde un `;` dentro de un texto con un separador", () => {
    expect(evaluateFormula('=CONCATENAR("a;b"; "c")', {})).toBe("a;bc");
  });

  it("admite mezclar los dos separadores en la misma fórmula", () => {
    expect(evaluateFormula("=SI(1>0; 10, 20)", {})).toBe(10);
  });
});

describe("rangos calificados por hoja en ambos extremos", () => {
  const valores = {
    "Tablas!B2": 1,
    "Tablas!B3": 2,
    "Tablas!B4": 3,
  };

  it("evalúa igual que la forma con prefijo único", () => {
    expect(evaluateFormula("=SUMA(Tablas!B2:Tablas!B4)", valores)).toBe(6);
    expect(evaluateFormula("=SUMA(Tablas!B2:B4)", valores)).toBe(6);
  });

  it("registra como precedentes todas las celdas del rango, no solo los extremos", () => {
    const precedentes = extractPrecedents(
      "=BUSCARV(A1;Tablas!B45:Tablas!C47;2;VERDADERO)",
      "Resumen",
    );

    expect([...precedentes].sort()).toEqual([
      "Resumen!A1",
      "Tablas!B45",
      "Tablas!B46",
      "Tablas!B47",
      "Tablas!C45",
      "Tablas!C46",
      "Tablas!C47",
    ]);
  });

  it("recalcula quien consulta el rango cuando cambia una celda interior", () => {
    const grafo = buildGraph({
      "Tablas!B45": { formula: "1" },
      "Tablas!C46": { formula: "2" },
      "Tablas!C47": { formula: "3" },
      "Resumen!A1": { formula: "=SUMA(Tablas!B45:Tablas!C47)" },
    });

    const { order } = getRecalcOrder(grafo, ["Tablas!C46"]);

    expect(order).toContain("Resumen!A1");
  });

  it("da error cuando los extremos nombran hojas distintas", () => {
    expect(evaluateFormula("=SUMA(Tablas!B2:Resumen!B9)", valores)).toBe(
      FORMULA_ERROR,
    );
  });
});

describe("celdas de gráfico", () => {
  const directiva =
    "DRAW:BOBINADO:D56:D59,D60,D61,D62:M59,M60,M61,M62:H59,H60,H61,H62:Q59,Q60,Q61,Q62:E56:G56:H56:I56";

  it("reconoce la directiva con y sin el signo igual", () => {
    expect(isGraphicDirective(`=${directiva}`)).toBe(true);
    expect(isGraphicDirective(directiva)).toBe(true);
    expect(isGraphicDirective("=SUMA(A1:A2)")).toBe(false);
    expect(isGraphicDirective("")).toBe(false);
  });

  it("devuelve la directiva como valor, sin el `=`", () => {
    expect(evaluateFormula(`=${directiva}`, {})).toBe(directiva);
    expect(evaluateFormula(directiva, {})).toBe(directiva);
    expect(graphicDirectiveValue(`=${directiva}`)).toBe(directiva);
  });

  it("no le inventa precedentes al grafo", () => {
    // Sin este trato, los tramos `D56:D59` y `D60,D61` de la directiva se
    // leen como rangos y referencias, y la celda acaba dependiendo de una
    // docena de celdas con las que no tiene relación.
    expect(extractPrecedents(`=${directiva}`, "Resumen").size).toBe(0);

    const grafo = buildGraph({ "Resumen!K73": { formula: `=${directiva}` } });
    expect(grafo.precedents.size).toBe(0);
    expect(grafo.dependents.size).toBe(0);
  });

  it("conserva su valor al evaluar el libro", async () => {
    const resultado = await evaluateSheet({
      "Resumen!K73": { formula: `=${directiva}` },
      "Resumen!D56": { formula: "10" },
    });

    expect(resultado.values["Resumen!K73"]).toBe(directiva);
  });
});

describe("regresión sobre la plantilla real TEMPLATE_1F_0001", () => {
  /**
   * La referencia no es "que no dé error", sino **el valor que el evaluador
   * anterior de project-front dejó guardado** en cada celda. Es la única
   * medida honesta de paridad: dice si la sustitución del evaluador cambió
   * algún número, que es justo lo que no debe pasar sin decidirlo.
   */
  const guardado: Record<string, number | string> = {
    "Resumen!G17": 20,
    "Resumen!I39": 1.4224751066856327,
    "Resumen!AE42": 115.2,
  };

  it("reproduce los valores que dejó guardados el evaluador anterior", async () => {
    const resultado = await evaluateSheet(libroReal());

    for (const [ref, esperado] of Object.entries(guardado)) {
      expect(resultado.values[ref], ref).toBe(esperado);
    }
  });

  it("resuelve la BUSCARV con `;` y rango calificado en ambos extremos", async () => {
    const resultado = await evaluateSheet(libroReal());

    // `G17` es `=G14*(VLOOKUP(G13;Tablas!B3:Tablas!C10;2;TRUE))`. Antes de
    // admitir el `;` y el rango calificado en los dos extremos daba `#ERROR`;
    // ahora vuelve a dar los 20 que tenía guardados.
    expect(resultado.values["Resumen!G17"]).toBe(20);
  });

  it("conserva el dibujo de K73", async () => {
    const resultado = await evaluateSheet(libroReal());

    expect(String(resultado.values["Resumen!K73"])).toMatch(/^DRAW:BOBINADO:/);
  });

  it("no deja ninguna celda circular", async () => {
    const resultado = await evaluateSheet(libroReal());

    expect(resultado.circular.size).toBe(0);
  });

  /**
   * `C6` es `=AE42*(VLOOKUP(I39*10; Tablas!B45:Tablas!C156; 2; TRUE))` y su
   * valor guardado es `0`, no un número de la tabla: el evaluador anterior
   * devolvía `0` cuando la búsqueda no encontraba nada, y esa búsqueda no
   * encuentra nada porque `Tablas!B45:C156` está a medio escribir (`B45` es
   * el texto `"T"` y de `B46` en adelante todo vale 9).
   *
   * El motor da `#ERROR` en vez de `0` por decisión explícita del change
   * anterior: un cálculo que salió mal no debe seguir viajando disfrazado de
   * número. Esta prueba fija esa diferencia para que se vea, en vez de
   * dejarla escondida entre los valores que sí coinciden.
   */
  it("deja en error la BUSCARV cuya tabla está incompleta", async () => {
    const resultado = await evaluateSheet(libroReal());

    expect(resultado.values["Resumen!C6"]).toBe(FORMULA_ERROR);
  });
});
