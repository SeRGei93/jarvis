CREATE TABLE `pending_confirmations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`session_id` integer,
	`tool_name` text NOT NULL,
	`args` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pending_confirmations_user` ON `pending_confirmations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_pending_confirmations_status` ON `pending_confirmations` (`status`);