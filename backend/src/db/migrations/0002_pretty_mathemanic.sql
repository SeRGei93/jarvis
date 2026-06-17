ALTER TABLE `sessions` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `summary_msg_count` integer DEFAULT 0 NOT NULL;