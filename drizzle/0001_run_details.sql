ALTER TABLE `scores` ADD `stage` integer;--> statement-breakpoint
ALTER TABLE `scores` ADD `played_at` integer;
--> statement-breakpoint
UPDATE `scores` SET `played_at` = `created_at` WHERE `played_at` IS NULL;
