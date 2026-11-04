# Panda Jobs — plan de rediseño visual (solo CSS)

## Tokens
- **Marca**: `--brand:#14532d` (verde profundo, identidad actual), `--brand-strong:#0c3a1f`,
  `--brand-mid:#1d6b3a`, `--brand-soft:#e9f4ec` (fondos tintados).
- **Papel**: `--bg:#f4f6f2` (gris-verdoso muy claro, plano, sin patrón de huellas),
  `--card:#ffffff`, `--line:#dde3da` (borde definido), `--line-strong:#c3cec0`.
- **Tinta**: `--ink:#17211a` (casi negro verdoso), `--muted:#5a665c`.
- **Dinero/aviso**: `--amber:#b45309` texto sobre `--amber-bg:#fdf3e0` (solo saldos/aviso).
- **Estados sobrios**: `--bad:#b3261e`, `--ok:#166534`, azul `--info:#1d5fae`.
- **Etapas** (píldora + punto + acento, un solo sistema): draft `#5b6a63` gris-verdoso,
  quote `#1d5fae` azul, signed `#1d7a3f` verde, scheduled `#6d4fa1` violeta apagado,
  in_progress `#a35b00` ámbar oscuro, done `#0e7a61` teal-verde, invoiced `#33665e`.
- **Forma**: radios `--r-lg:16px / --r-md:12px / --r-sm:9px`; elevación en 2 niveles
  (`--sh-1` sutil para tarjetas en reposo, `--sh-2` para la tarjeta de etapa activa y
  paneles de confirmación); `--ring` de foco visible (3px, verde con halo claro).
- **Tipo**: pila del sistema; escala 15px base, h2 19/700, etiquetas 12.5px en mayúsculas
  sobrias; números de dinero con `font-variant-numeric: tabular-nums` y tamaño mayor.

## Jerarquía
- La tarjeta de la **etapa activa** del detalle manda: borde izquierdo de etapa +
  elevación `--sh-2` y fondo apenas tintado; las demás tarjetas quedan planas con `--sh-1`.
- Dinero: filas Total/Balance con números grandes tabulares; saldo pendiente en ámbar.
- Botones ≥46px (primario verde sólido sin degradado brillante, secundario contorno,
  peligro sobrio), `:focus-visible` con anillo, `prefers-reduced-motion` respetado.
- Header fijo sobrio (verde sólido, sin degradado arcoíris), marca con logo en pastilla blanca.
- Portal del cliente: cabecera verde sobria, tarjeta de firma con borde sólido y fondo blanco puro.

## Pantallas (antes/después)
01 tablero de trabajos · 02 detalle cotización · 03 detalle En curso ·
04 portal del cliente (firma) · 05 detalle Terminado.
