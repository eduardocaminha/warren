ALTER TABLE "plan_runs" ADD COLUMN "resume_at" text;--> statement-breakpoint
ALTER TABLE "plan_runs" ADD COLUMN "rate_limit_retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resets_at" text;