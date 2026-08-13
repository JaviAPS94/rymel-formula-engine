/**
 * Funciones personalizadas: las fórmulas de diseño, invocadas desde una
 * celda como `=CUBIC(A1, B2)`.
 *
 * El motor no sabe evaluarlas y no debe saberlo. La expresión está cifrada y
 * solo el motor cifrado puede resolverla; el navegador nunca la ve. Por eso
 * aquí solo se define el puerto: el consumidor inyecta cómo se resuelve un
 * lote de invocaciones, y el motor se limita a reconocerlas, ordenarlas y
 * agruparlas.
 *
 * project-front inyecta una implementación que va por HTTP a project-back;
 * project-back inyecta una que resuelve en proceso. El núcleo del motor no
 * contiene ninguna URL ni ningún transporte.
 */

/**
 * Lo que el motor necesita saber de una función personalizada para
 * reconocerla en una fórmula: cómo se la invoca y qué variables declara.
 *
 * El orden de `variables` es contrato: las hojas pasan los argumentos por
 * posición, de modo que `variables[0]` recibe el primer argumento. Alterarlo
 * cambia en silencio el resultado de toda hoja ya guardada.
 */
export interface CustomFunctionDefinition {
  /** Nombre con el que se invoca desde una celda, p. ej. `CUBIC`. */
  code: string;
  /** Variables declaradas, en el orden en que reciben los argumentos. */
  variables: string[];
  /** Identificador con el que el consumidor resuelve la función. */
  id?: number | string;
}

/** Una invocación concreta que hay que resolver. */
export interface CustomFunctionCall {
  /** Definición de la función invocada. */
  definition: CustomFunctionDefinition;
  /** Argumentos ya evaluados, asociados a las variables por posición. */
  parameters: Record<string, number>;
}

/** Resultado de una invocación, en la misma posición que en el lote de entrada. */
export interface CustomFunctionResult {
  value?: number;
  /** Motivo del fallo; si viene, la celda queda en error. */
  error?: string;
}

/**
 * El puerto. Recibe un lote completo y devuelve un resultado por cada
 * invocación, **en el mismo orden**.
 *
 * Recibe un lote y no una invocación suelta a propósito: es lo que permite
 * que una hoja con cuarenta celdas independientes haga una sola petición de
 * red en vez de cuarenta.
 */
export type CustomFunctionResolver = (
  calls: CustomFunctionCall[],
) => Promise<CustomFunctionResult[]>;

/** Índice por código, en mayúsculas, para resolver durante la evaluación. */
export type CustomFunctionRegistry = Map<string, CustomFunctionDefinition>;

export const buildRegistry = (
  definitions: readonly CustomFunctionDefinition[],
): CustomFunctionRegistry => {
  const registry: CustomFunctionRegistry = new Map();
  for (const definition of definitions) {
    registry.set(definition.code.toUpperCase(), definition);
  }
  return registry;
};

/**
 * Detecta códigos que hacen ambigua la resolución en una hoja.
 *
 * Cuando un código es sufijo de otro (`COST` y `ASSOCIATE_COST`), un
 * resolutor basado en expresiones regulares sobre el texto captura el corto
 * dentro del largo. Este motor no tiene ese defecto, porque reconoce el
 * código como una unidad léxica completa, pero el consumidor sí necesita
 * saber de la colisión: project-back la rechaza al crear la fórmula y
 * project-admin la señala en el listado.
 */
export const findCollidingCodes = (
  definitions: readonly CustomFunctionDefinition[],
): Array<[string, string]> => {
  const collisions: Array<[string, string]> = [];
  const codes = definitions.map((definition) => definition.code.toUpperCase());

  for (let i = 0; i < codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      if (i === j) continue;
      const a = codes[i];
      const b = codes[j];
      if (a === b ? i < j : b.endsWith(a)) collisions.push([a, b]);
    }
  }

  return collisions;
};
