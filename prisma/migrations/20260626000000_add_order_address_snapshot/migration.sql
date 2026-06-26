-- AlterTable
-- Snapshot de la dirección de entrega congelada al crear el pedido.
-- Todas las columnas son opcionales: PICKUP y pedidos previos no las tienen.
ALTER TABLE "orders" ADD COLUMN     "delivery_label" TEXT,
ADD COLUMN     "delivery_direction" TEXT,
ADD COLUMN     "delivery_departament" TEXT,
ADD COLUMN     "delivery_reference" TEXT,
ADD COLUMN     "delivery_contact" TEXT,
ADD COLUMN     "delivery_latitude" DECIMAL(10,8),
ADD COLUMN     "delivery_longitude" DECIMAL(11,8);
