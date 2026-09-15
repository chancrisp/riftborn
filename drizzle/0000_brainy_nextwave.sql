CREATE TABLE `scores` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`score` integer NOT NULL,
	`kills` integer NOT NULL,
	`wave` integer NOT NULL,
	`seconds` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scores_ranking` ON `scores` (`score`,`wave`,`seconds`);