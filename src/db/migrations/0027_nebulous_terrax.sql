ALTER TABLE `plan_runs` ADD `resume_at` text;--> statement-breakpoint
ALTER TABLE `plan_runs` ADD `rate_limit_retries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `resets_at` text;