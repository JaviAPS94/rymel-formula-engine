/**
 * Referencias calificadas por hoja: `Hoja1!A1`, `'Template 1F'!A11:B20`.
 *
 * El diseñador de project-front reparte un diseño en varias hojas y las
 * fórmulas cruzan de una a otra. El motor las trata como cualquier otra
 * referencia — participan del grafo de dependencias igual que las locales —
 * y para eso necesita una forma canónica única por celda.
 *
 * La forma canónica es `NombreHoja!A1`: sin comillas, sin `$`, con la parte
 * de celda en mayúsculas. El nombre de la hoja se conserva tal cual, porque
 * es un dato que escribió el usuario ("Template 1F") y no nos corresponde
 * normalizarlo.
 */

/** Nombre de hoja entre comillas simples, admitiendo `''` como comilla escapada. */
const QUOTED_SHEET = "'(?:[^']|'')*'";
/**
 * Nombre de hoja sin comillas: sin espacios, para que no sea ambiguo dónde
 * termina.
 *
 * Admite empezar por dígito. No es un capricho: los subtipos de diseño de
 * este sistema se llaman `1F` y `3F`, y una hoja con ese nombre produce
 * referencias como `1F!A1`. El evaluador anterior las acepta —su patrón es
 * `[A-Za-z0-9]+!`— así que exigir una letra inicial habría roto esas hojas al
 * conmutar. Las referencias van siempre antes que los números en el
 * tokenizador, así que `1F!A1` no se confunde con el número 1.
 */
const BARE_SHEET = "[A-Za-z0-9_][A-Za-z0-9_.]*";

/**
 * Prefijo opcional de instancia, con dos puntos: `design:Hoja1!A1`.
 *
 * El diseñador de project-front reparte un diseño en varias instancias
 * (diseño y costos) y una hoja puede referenciar celdas de la otra. Sin esta
 * forma, esas fórmulas no se podrían ni analizar.
 */
const INSTANCE_PREFIX = "[A-Za-z0-9_.]+:";

const SHEET_PREFIX = `(?:${INSTANCE_PREFIX})?(?:${QUOTED_SHEET}|${BARE_SHEET})!`;
const CELL_PART = "\\$?[A-Za-z]+\\$?\\d+";

/** Fuente de la expresión regular de una referencia calificada, celda o rango. */
export const QUALIFIED_REF_SOURCE = `${SHEET_PREFIX}${CELL_PART}(?::${CELL_PART})?`;

const QUALIFIED_REF_PATTERN = new RegExp(`^${QUALIFIED_REF_SOURCE}$`);

export interface QualifiedRef {
  /** Nombre de la hoja, ya sin comillas. */
  sheet: string;
  /** Parte de celda o rango, en mayúsculas y sin `$`: `A1` o `A1:B5`. */
  cell: string;
}

/** `true` si el token es una referencia calificada por hoja. */
export const isQualifiedRef = (token: string): boolean =>
  QUALIFIED_REF_PATTERN.test(token.trim());

const unquoteSheetName = (name: string): string =>
  name.startsWith("'") ? name.slice(1, -1).replace(/''/g, "'") : name;

/**
 * Separa una referencia calificada en hoja y celda. Devuelve `null` si el
 * token no lleva calificador de hoja.
 */
export const parseQualifiedRef = (token: string): QualifiedRef | null => {
  const trimmed = token.trim();
  if (!QUALIFIED_REF_PATTERN.test(trimmed)) return null;

  const separator = trimmed.lastIndexOf("!");
  return {
    sheet: unquoteSheetName(trimmed.slice(0, separator)),
    cell: trimmed.slice(separator + 1).replace(/\$/g, "").toUpperCase(),
  };
};

/** Construye la forma canónica `NombreHoja!A1`. */
export const qualify = (sheet: string, cell: string): string =>
  `${sheet}!${cell.replace(/\$/g, "").toUpperCase()}`;

/**
 * Lleva cualquier referencia a su forma canónica.
 *
 * Una referencia sin calificador pertenece a `currentSheet`; si no se indica
 * hoja actual, se deja tal cual, que es el comportamiento de una sola hoja
 * que usa la grilla de ítems fantasma.
 */
export const normalizeRef = (token: string, currentSheet?: string): string => {
  const trimmed = token.trim();

  const qualified = parseQualifiedRef(trimmed);
  if (qualified) return qualify(qualified.sheet, qualified.cell);

  // Una referencia ya canónica lleva `!` pero su nombre de hoja puede tener
  // espacios y por eso no vuelve a encajar en el patrón de entrada. Se
  // reconoce por el separador y se deja como está.
  const separator = trimmed.lastIndexOf("!");
  if (separator !== -1) {
    return qualify(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }

  const bare = trimmed.replace(/\$/g, "").toUpperCase();
  return currentSheet === undefined ? bare : qualify(currentSheet, bare);
};

/** Separa una referencia canónica en hoja y celda; `sheet` es `undefined` si no la lleva. */
export const splitRef = (ref: string): { sheet?: string; cell: string } => {
  const separator = ref.lastIndexOf("!");
  if (separator === -1) return { cell: ref };
  return { sheet: ref.slice(0, separator), cell: ref.slice(separator + 1) };
};
