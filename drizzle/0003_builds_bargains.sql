ALTER TABLE `scores` ADD `statue_count` integer;--> statement-breakpoint
ALTER TABLE `scores` ADD `statue_modifier` integer;--> statement-breakpoint
ALTER TABLE `scores` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `scores` ADD `gameplay_version` text;--> statement-breakpoint
CREATE INDEX `idx_scores_mode_version` ON `scores` (`death_mode`,`gameplay_version`,`score`,`wave`,`seconds`);