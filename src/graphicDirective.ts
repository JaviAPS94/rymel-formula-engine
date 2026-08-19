/**
 * Celdas de gráfico.
 *
 * El diseñador de project-front dibuja dentro de una celda a partir de una
 * directiva de texto: `DRAW:BOBINADO:D56:D59,D60,...`. La celda la renderiza
 * un componente propio, que lee el texto y lo interpreta; el motor no tiene
 * nada que calcular ahí.
 *
 * El problema es que las plantillas existentes la guardan **con el `=`
 * delante**, así que sin este reconocimiento el motor la toma por una fórmula.
 * Y no falla de forma inocua:
 *
 * 1. La evaluación da `#ERROR`, y como el renderizador busca la directiva en
 *    el valor calculado de la celda cuando el contenido empieza por `=`, el
 *    dibujo desaparece en cuanto la hoja se recalcula.
 * 2. El grafo de dependencias se contamina: los tramos `D56:D59` y `D60,D61`
 *    de la directiva parecen rangos y referencias, así que la celda queda con
 *    precedentes que no existen y arrastra recálculos que no le tocan.
 *
 * De ahí que sea una clase de contenido aparte, y no un caso particular de
 * fórmula: no se evalúa, no aporta dependencias, y su valor es su propio
 * texto sin el `=`, que es la forma que el renderizador espera.
 */

/** Prefijo que marca el contenido de una celda como directiva de gráfico. */
const GRAPHIC_PREFIX = "DRAW:";

/**
 * Contenido de la celda sin el `=` inicial ni espacios alrededor.
 * `undefined` para un contenido vacío.
 */
const bareContent = (content: string | undefined | null): string | undefined => {
  if (content === undefined || content === null) return undefined;
  const trimmed = String(content).trim();
  if (trimmed === "") return undefined;
  return trimmed.startsWith("=") ? trimmed.slice(1).trimStart() : trimmed;
};

/** `true` si el contenido de la celda es una directiva de gráfico, con `=` o sin él. */
export const isGraphicDirective = (
  content: string | undefined | null,
): boolean => (bareContent(content) ?? "").toUpperCase().startsWith(GRAPHIC_PREFIX);

/**
 * Valor de una celda de gráfico: su propia directiva, sin el `=` inicial.
 * Devuelve `undefined` si el contenido no es una directiva.
 */
export const graphicDirectiveValue = (
  content: string | undefined | null,
): string | undefined =>
  isGraphicDirective(content) ? bareContent(content) : undefined;

/**
 * `true` si el contenido debe evaluarse como fórmula.
 *
 * Empieza por `=` y no es una directiva de gráfico. Es la única pregunta que
 * el motor necesita hacerse para decidir qué hacer con una celda, y por eso
 * vive en un solo sitio.
 */
export const isFormulaContent = (
  content: string | undefined | null,
): boolean => {
  if (content === undefined || content === null) return false;
  const trimmed = String(content).trim();
  return trimmed.startsWith("=") && !isGraphicDirective(trimmed);
};
