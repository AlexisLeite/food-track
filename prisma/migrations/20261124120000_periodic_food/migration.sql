CREATE TABLE "periodic_food" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "source_meal_id" TEXT NOT NULL,
  "snapshot" TEXT NOT NULL,
  "next_date" TEXT NOT NULL,
  UNIQUE ("user_id", "source_meal_id")
);

CREATE INDEX "periodic_food_next_date_idx" ON "periodic_food"("next_date");

ALTER TABLE "meals" ADD COLUMN "periodic_food_id" TEXT REFERENCES "periodic_food"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "meals_periodic_food_id_idx" ON "meals"("periodic_food_id");
