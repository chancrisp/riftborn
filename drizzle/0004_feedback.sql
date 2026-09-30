CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`category` text NOT NULL,
	`rating` integer,
	`message` text NOT NULL,
	`contact` text,
	`context_json` text,
	`source` text NOT NULL,
	`build` text,
	`status` text DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_created` ON `feedback` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_status_created` ON `feedback` (`status`,`created_at`);