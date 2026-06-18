CREATE TABLE `access_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tg_user_id` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`username` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_requests_tg_user_id_unique` ON `access_requests` (`tg_user_id`);--> statement-breakpoint
CREATE INDEX `idx_access_requests_status` ON `access_requests` (`status`);