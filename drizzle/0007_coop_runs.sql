CREATE TABLE IF NOT EXISTS `coop_runs` (
	`id` INTEGER PRIMARY KEY,
	`created_at` INTEGER NOT NULL,
	`version` TEXT NOT NULL,
	`stamp` TEXT NOT NULL,
	`world` INTEGER NOT NULL,
	`seed` INTEGER NOT NULL,
	`clear_ms` INTEGER NOT NULL,
	`kills` INTEGER NOT NULL,
	`a_account` TEXT NOT NULL,
	`a_name` TEXT NOT NULL,
	`b_account` TEXT NOT NULL,
	`b_name` TEXT NOT NULL,
	`room` TEXT NOT NULL,
	`hash` TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `coop_runs_board` ON `coop_runs` (`stamp`,`clear_ms`,`kills`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `coop_runs_a` ON `coop_runs` (`a_account`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `coop_runs_b` ON `coop_runs` (`b_account`);