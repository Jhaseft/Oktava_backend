-- Migration: 20260528000000_daily_order_sequence
-- Cambia el número de pedido de aleatorio global a secuencial diario (OKT-0001 ... OKT-9999).
--
-- CAMBIOS:
--   1. Agrega columna order_date (DATE) con default CURRENT_DATE — no destructivo.
--   2. Elimina el índice único global en order_number.
--   3. Crea índice único compuesto (order_date, order_number) — unicidad dentro del día.
--
-- SEGURIDAD:
--   • ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS: idempotente.
--   • DROP INDEX IF EXISTS: no falla si ya fue eliminado.
--   • Ningún DROP TABLE / TRUNCATE / DELETE.
--   • Órdenes existentes reciben order_date = CURRENT_DATE (fecha de migración).
--     Sus números son aleatorios OKT-XXXXX (5 dígitos) — no colisionan con
--     los secuenciales OKT-XXXX (4 dígitos) del nuevo sistema.

-- ─── 1. Agregar columna order_date ────────────────────────────────────────────
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "order_date" DATE NOT NULL DEFAULT CURRENT_DATE;

-- ─── 2. Eliminar índice único global en order_number ──────────────────────────
DROP INDEX IF EXISTS "orders_order_number_key";

-- ─── 3. Crear índice único compuesto (order_date, order_number) ───────────────
CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_date_order_number_key"
  ON "orders"("order_date", "order_number");
