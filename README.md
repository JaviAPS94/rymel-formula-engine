# @rymel/formula-engine

Motor de fórmulas de hoja de cálculo de Rymel. Analiza y evalúa fórmulas
(`=P3/O3`, `=SUMA(A1:A5)`, `=SI(B1>0, "sí", "no")`) contra un mapa de celdas,
y mantiene el grafo de dependencias que determina el orden de recálculo.

Lo consumen `project-admin` (grilla de ítems fantasma), `project-front`
(diseñador tipo Excel) y `project-back` (recálculo de diseños en el servidor).

## Por qué existe

El mismo cálculo tiene que dar el mismo número en los tres. Cuando el motor
vive duplicado en cada consumidor, un diseño recalculado en el servidor deja
de coincidir con lo que el usuario vio en pantalla, y ninguno de los dos
resultados es más confiable que el otro.

De ahí las dos restricciones que gobiernan este paquete:

1. **Cero dependencias de runtime, y ninguna API de Node ni del navegador.**
   Se verifica en cada build con `npm run check:deps`.
2. **Nada de `eval` ni `new Function`.** Las fórmulas se analizan
   (tokenización → notación polaca inversa → evaluación sobre pila), no se
   ejecutan como JavaScript. Una fórmula puede venir de un `.xlsx` que subió
   un usuario.

## Uso

```ts
import { buildGraph, getRecalcOrder, evaluateFormula } from "@rymel/formula-engine";

const cells = {
  A1: { formula: "10" },
  A2: { formula: "20" },
  B1: { formula: "=SUMA(A1:A2)" },
};

const graph = buildGraph(cells);
const { order, circular } = getRecalcOrder(graph, ["A1"]);

const values: Record<string, number | string> = { A1: 10, A2: 20 };
for (const ref of order) {
  values[ref] = evaluateFormula(cells[ref].formula, values);
}
// values.B1 === 30
```

## Funciones incorporadas

Cada una responde a su nombre en español (el que se escribe en las plantillas)
y a su alias en inglés:

| Español | Inglés | |
|---|---|---|
| `SUMA` | `SUM` | suma, ignorando lo no numérico |
| `PROMEDIO` | `AVERAGE` | media de los valores numéricos |
| `LARGO` | `LEN` | longitud del texto |
| `SI` | `IF` | condicional de tres argumentos |
| `REDONDEAR` | `ROUND` | redondeo a N decimales |
| `CONCATENAR` | `CONCAT` | concatenación |
| `IZQUIERDA` | `LEFT` | primeros N caracteres |
| `DERECHA` | `RIGHT` | últimos N caracteres |

Operadores: `+ - * / ^ &`, comparadores `= <> < > <= >=`, paréntesis, negación
unaria, referencias `A1` y `$A$1`, y rangos `A1:B5`.

## Desarrollo

```bash
npm install
npm run verify     # portabilidad + tipos + pruebas + build
npm test
```

## Consumo y versionado

Se instala fijado a un tag inmutable:

```json
"@rymel/formula-engine": "github:JaviAPS94/rymel-formula-engine#v1.0.0"
```

Ningún consumidor apunta a `main`: una publicación no debe cambiarle el
resultado a un repositorio que no la pidió.

**El resultado numérico es parte del contrato.** Un cambio que altere el valor
de una fórmula ya válida se publica como versión mayor, aunque no toque
ninguna firma pública, y las notas de la versión declaran la divergencia.
