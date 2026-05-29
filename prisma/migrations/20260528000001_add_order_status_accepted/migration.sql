-- Migration: 20260528000001_add_order_status_accepted
-- Agrega el valor ACCEPTED al enum OrderStatus de PostgreSQL.
--
-- SEGURIDAD:
--   • ADD VALUE IF NOT EXISTS: idempotente, no falla si ya existe.
--   • No toca datos existentes.
--   • No hay DROP, TRUNCATE ni DELETE.
--   • AFTER 'PENDING': posiciona ACCEPTED inmediatamente después de PENDING
--     (requiere PostgreSQL 9.1+; si la versión es anterior, omitir AFTER y
--     el valor se agrega al final — funcionalmente equivalente para Prisma).

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED' AFTER 'PENDING';
