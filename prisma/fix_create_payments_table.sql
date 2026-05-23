-- Crea la tabla payments si no existe.
-- Seguro: solo CREATE IF NOT EXISTS / ADD CONSTRAINT IF NOT EXISTS.
-- No toca enum OrderStatus ni ninguna otra tabla.

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

CREATE UNIQUE INDEX IF NOT EXISTS "payments_order_id_key"
    ON "payments"("order_id");

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payments_order_id_fkey'
    ) THEN
        ALTER TABLE "payments"
            ADD CONSTRAINT "payments_order_id_fkey"
            FOREIGN KEY ("order_id") REFERENCES "orders"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payments_user_id_fkey'
    ) THEN
        ALTER TABLE "payments"
            ADD CONSTRAINT "payments_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
