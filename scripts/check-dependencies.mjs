/**
 * Guardarraíl de portabilidad.
 *
 * El paquete tiene que producir exactamente el mismo resultado en el
 * navegador (project-front, project-admin) y en Node (project-back), porque
 * el recálculo de diseños en el servidor se compara contra lo que el usuario
 * ve en pantalla. En cuanto el motor dependa del entorno, esa comparación
 * deja de significar nada.
 *
 * Esto falla el build si el código de producción:
 *   - declara dependencias de runtime,
 *   - importa cualquier módulo que no sea relativo,
 *   - o toca una API propia de Node o del navegador.
 *
 * Los archivos `*.spec.ts` quedan fuera: no se publican y pueden importar
 * el runner de pruebas.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

/** APIs que atan el código a un entorno concreto. */
const FORBIDDEN_GLOBALS = [
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "fetch",
  "XMLHttpRequest",
  "process",
  "Buffer",
  "__dirname",
  "__filename",
  "require",
];

/** Mecanismos de ejecución dinámica: prohibidos por diseño, no solo por portabilidad. */
const FORBIDDEN_EVAL = ["eval", "Function"];

const listSourceFiles = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listSourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });

/**
 * Quita comentarios y literales de cadena para no marcar menciones en prosa.
 * No es un parser: es suficiente para un guardarraíl, y prefiere marcar de
 * más antes que dejar pasar algo.
 */
const stripCommentsAndStrings = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '""')
    .replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""')
    .replace(/'(?:[^'\\]|\\[\s\S])*'/g, '""')
    .replace(/\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, " ");

const violations = [];
const report = (file, line, message) => {
  violations.push(`${relative(ROOT, file)}:${line}  ${message}`);
};

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

for (const file of listSourceFiles(SRC)) {
  const isSpec = file.endsWith(".spec.ts");
  const raw = readFileSync(file, "utf8");
  const code = stripCommentsAndStrings(raw);

  // Importaciones: solo se admiten rutas relativas en el código publicado.
  const importPattern = /\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)/g;
  for (const match of raw.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier.startsWith(".")) continue;
    if (isSpec && specifier === "vitest") continue;
    report(
      file,
      lineOf(raw, match.index),
      `importa "${specifier}"; el paquete no admite dependencias externas`,
    );
  }

  if (isSpec) continue;

  for (const name of FORBIDDEN_GLOBALS) {
    const pattern = new RegExp(`(?<![.\\w$])${name}\\b`, "g");
    for (const match of code.matchAll(pattern)) {
      report(file, lineOf(code, match.index), `usa "${name}", propio de un entorno`);
    }
  }

  for (const name of FORBIDDEN_EVAL) {
    const pattern = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, "g");
    for (const match of code.matchAll(pattern)) {
      report(
        file,
        lineOf(code, match.index),
        `invoca "${name}()"; el motor no ejecuta fórmulas como código`,
      );
    }
  }
}

// Dependencias de runtime declaradas.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
if (runtimeDeps.length > 0) {
  violations.push(
    `package.json  declara dependencias de runtime: ${runtimeDeps.join(", ")}`,
  );
}
for (const field of ["peerDependencies", "optionalDependencies"]) {
  const names = Object.keys(pkg[field] ?? {});
  if (names.length > 0) {
    violations.push(`package.json  declara ${field}: ${names.join(", ")}`);
  }
}

if (violations.length > 0) {
  console.error("Verificación de portabilidad fallida:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "\nEl paquete debe correr igual en navegador y en Node. Ver design.md, decisión 1.",
  );
  process.exit(1);
}

console.log("Verificación de portabilidad correcta: sin dependencias ni APIs de entorno.");
