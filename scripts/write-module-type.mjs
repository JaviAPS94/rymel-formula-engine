/**
 * `tsc` emite JavaScript pero no declara a qué sistema de módulos pertenece
 * cada carpeta. Como el paquete es `"type": "module"`, Node interpretaría la
 * salida CommonJS como ESM y fallaría al cargarla.
 *
 * Un `package.json` mínimo dentro de cada carpeta de salida fija el sistema
 * de módulos que le corresponde.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));

for (const [dir, type] of [
  ["esm", "module"],
  ["cjs", "commonjs"],
]) {
  writeFileSync(join(DIST, dir, "package.json"), `${JSON.stringify({ type }, null, 2)}\n`);
}

console.log("Sistema de módulos declarado en dist/esm y dist/cjs.");
