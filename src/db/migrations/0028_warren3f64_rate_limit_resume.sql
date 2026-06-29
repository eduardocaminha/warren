ALTER TABLE `runs` ADD `resume_at` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `resume_attempts` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX `runs_resume_at_idx` ON `runs` (`resume_at`) WHERE `resume_at` IS NOT NULL;
