-- Migration: 20260522000000_add_payment_model
-- Adds the Payment model and two new OrderStatus variants (PENDING_PAYMENT, PAYMENT_FAILED).
--
-- SAFETY: Every statement uses IF NOT EXISTS / ADD VALUE IF NOT EXISTS so this
-- file can be re-executed against a DB that already has these objects without error.
-- No DROP, TRUNCATE or DELETE statements are included.

-- ─── OrderStatus: new variants ────────────────────────────────────────────────
-- ADD VALUE IF NOT EXISTS is available since PostgreSQL 9.3.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_FAILED';

-- ─── Create payments table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payments" (
    "id"                      TEXT          NOT NULL,
    "order_id"                TEXT          NOT NULL,
    "user_id"                 TEXT          NOT NULL,
    "provider"                TEXT          NOT NULL,
    "status"                  TEXT          NOT NULL,
    "amount"                  DECIMAL(10,2) NOT NULL,
    "currency"                TEXT          NOT NULL DEFAULT 'PEN',
    "gateway_purchase_number" TEXT,
    "gateway_session_key"     TEXT,
    "gateway_transaction_id"  TEXT,
    "gateway_auth_code"       TEXT,
    "gateway_response_code"   TEXT,
    "gateway_response_json"   JSONB,
    "paid_at"                 TIMESTAMP(3),
    "failed_at"               TIMESTAMP(3),
    "created_at"              TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMP(3)  NOT NULL,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- ─── Unique index on order_id ─────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "payments_order_id_key" ON "payments"("order_id");

-- ─── Foreign keys (conditional: skip if already exist) ────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_order_id_fkey'
      AND conrelid = 'payments'::regclass
  ) THEN
    ALTER TABLE "payments"
      ADD CONSTRAINT "payments_order_id_fkey"
      FOREIGN KEY ("order_id") REFERENCES "orders"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_user_id_fkey'
      AND conrelid = 'payments'::regclass
  ) THEN
    ALTER TABLE "payments"
      ADD CONSTRAINT "payments_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
