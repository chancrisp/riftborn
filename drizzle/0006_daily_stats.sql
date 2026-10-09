CREATE TABLE IF NOT EXISTS `daily_stats` (
	`day` TEXT NOT NULL,
	`metric` TEXT NOT NULL,
	`dim` TEXT NOT NULL,
	`n` INTEGER DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `metric`, `dim`)
) WITHOUT ROWID;
