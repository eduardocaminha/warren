ALTER TABLE "runs" ADD COLUMN "resume_at" text;
ALTER TABLE "runs" ADD COLUMN "resume_attempts" integer NOT NULL DEFAULT 0;
CREATE INDEX "runs_resume_at_idx" ON "runs" ("resume_at") WHERE "resume_at" IS NOT NULL;
