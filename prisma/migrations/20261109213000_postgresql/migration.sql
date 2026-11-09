-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "profile" TEXT,
    "enable_codex_extraction" INTEGER NOT NULL DEFAULT 0,
    "theme" TEXT NOT NULL DEFAULT 'dark',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires" BIGINT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "meals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "photo" TEXT NOT NULL,
    "selected" TEXT,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "meals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analyses" (
    "id" TEXT NOT NULL,
    "meal_id" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "ordinal" BIGSERIAL NOT NULL,

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_descriptions" (
    "meal_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "meal_descriptions_pkey" PRIMARY KEY ("meal_id")
);

-- CreateTable
CREATE TABLE "profile_goals" (
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "profile" TEXT NOT NULL,

    CONSTRAINT "profile_goals_pkey" PRIMARY KEY ("user_id","date")
);

-- CreateTable
CREATE TABLE "submission_receipts" (
    "user_id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "response" TEXT NOT NULL,

    CONSTRAINT "submission_receipts_pkey" PRIMARY KEY ("user_id","submission_id")
);

-- CreateTable
CREATE TABLE "profile_versions" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "profile_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workouts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "estimate" TEXT NOT NULL,
    "confirmed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "workouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usage" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cached_tokens" INTEGER,
    "reasoning_tokens" INTEGER,
    "total_tokens" INTEGER,
    "created_at" TEXT NOT NULL,
    "speed" TEXT NOT NULL DEFAULT 'standard',
    "model" TEXT NOT NULL DEFAULT 'gpt-6.1-sol',

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usage_meta" (
    "id" INTEGER NOT NULL,
    "started_at" TEXT NOT NULL,

    CONSTRAINT "token_usage_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_reservations" (
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "usage_reservations_pkey" PRIMARY KEY ("user_id","kind","request_key")
);

-- CreateTable
CREATE TABLE "usage_limits_meta" (
    "id" INTEGER NOT NULL,

    CONSTRAINT "usage_limits_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_at" BIGINT NOT NULL DEFAULT 0,
    "result" TEXT,
    "error" TEXT,
    "created_at" TEXT NOT NULL,
    "ordinal" BIGSERIAL NOT NULL,

    CONSTRAINT "extraction_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout_clarifications" (
    "id" TEXT NOT NULL,
    "workout_id" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "estimate" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "ordinal" BIGSERIAL NOT NULL,

    CONSTRAINT "workout_clarifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_idx" ON "sessions"("expires");

-- CreateIndex
CREATE INDEX "meals_user_id_date_idx" ON "meals"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "analyses_ordinal_key" ON "analyses"("ordinal");

-- CreateIndex
CREATE INDEX "analyses_meal_id_created_at_idx" ON "analyses"("meal_id", "created_at");

-- CreateIndex
CREATE INDEX "profile_versions_user_id_date_id_idx" ON "profile_versions"("user_id", "date", "id");

-- CreateIndex
CREATE INDEX "workouts_user_id_date_idx" ON "workouts"("user_id", "date");

-- CreateIndex
CREATE INDEX "token_usage_date_user_id_idx" ON "token_usage"("date", "user_id");

-- CreateIndex
CREATE INDEX "usage_reservations_user_id_kind_period_idx" ON "usage_reservations"("user_id", "kind", "period");

-- CreateIndex
CREATE UNIQUE INDEX "extraction_jobs_ordinal_key" ON "extraction_jobs"("ordinal");

-- CreateIndex
CREATE INDEX "extraction_jobs_state_next_at_idx" ON "extraction_jobs"("state", "next_at");

-- CreateIndex
CREATE INDEX "extraction_jobs_resource_id_idx" ON "extraction_jobs"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "extraction_jobs_user_id_request_key_key" ON "extraction_jobs"("user_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "workout_clarifications_ordinal_key" ON "workout_clarifications"("ordinal");

-- CreateIndex
CREATE INDEX "workout_clarifications_workout_id_created_at_idx" ON "workout_clarifications"("workout_id", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meals" ADD CONSTRAINT "meals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_meal_id_fkey" FOREIGN KEY ("meal_id") REFERENCES "meals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_descriptions" ADD CONSTRAINT "meal_descriptions_meal_id_fkey" FOREIGN KEY ("meal_id") REFERENCES "meals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_goals" ADD CONSTRAINT "profile_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_receipts" ADD CONSTRAINT "submission_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_clarifications" ADD CONSTRAINT "workout_clarifications_workout_id_fkey" FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Preserve the historical configuration lookup, including legacy goal records.
CREATE VIEW profile_timeline AS
 SELECT user_id,date,profile FROM profile_versions v
 WHERE id=(SELECT MAX(id) FROM profile_versions latest WHERE latest.user_id=v.user_id AND latest.date=v.date)
 UNION ALL
 SELECT user_id,date,profile FROM profile_goals legacy
 WHERE NOT EXISTS(SELECT 1 FROM profile_versions v WHERE v.user_id=legacy.user_id AND v.date=legacy.date);
ALTER TABLE users ADD CONSTRAINT users_extraction_flag CHECK (enable_codex_extraction IN (0,1));
ALTER TABLE users ADD CONSTRAINT users_theme CHECK (theme IN ('dark','light'));
ALTER TABLE token_usage ADD CONSTRAINT token_usage_speed CHECK (speed IN ('standard','fast','ultrafast'));
ALTER TABLE token_usage_meta ADD CONSTRAINT token_usage_meta_singleton CHECK (id=1);
