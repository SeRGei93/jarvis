CREATE TABLE `bot_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`bot_name` text DEFAULT '' NOT NULL,
	`vibe` text DEFAULT '' NOT NULL,
	`system_prompt_override` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_identities_user_id_unique` ON `bot_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `cron_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`session_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`skill_name` text DEFAULT '' NOT NULL,
	`schedule` text DEFAULT '' NOT NULL,
	`scheduled_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_run_status` text,
	`last_run_error` text,
	`notification_chat_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cron_tasks_user` ON `cron_tasks` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_cron_tasks_session` ON `cron_tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_cron_tasks_active` ON `cron_tasks` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_cron_tasks_scheduled` ON `cron_tasks` (`scheduled_at`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`category` text NOT NULL,
	`scope` text DEFAULT 'permanent' NOT NULL,
	`session_id` integer,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_memories_user` ON `memories` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_session` ON `memories` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_scope` ON `memories` (`scope`);--> statement-breakpoint
CREATE TABLE `message_rate_limits` (
	`user_id` integer NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `window_start`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ref` text NOT NULL,
	`provider` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`supports_tools` integer DEFAULT true NOT NULL,
	`supports_reasoning` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_ref_unique` ON `models` (`ref`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`key` text PRIMARY KEY NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`user_id` integer,
	`model` text NOT NULL,
	`thread_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_chat_id_unique` ON `sessions` (`chat_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`allowed_tools` text DEFAULT '[]' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`temperature` real,
	`reasoning` integer,
	`routable` integer DEFAULT true NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`hourly_limit` integer NOT NULL,
	`max_tasks` integer DEFAULT 3 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_plans_name_unique` ON `subscription_plans` (`name`);--> statement-breakpoint
CREATE TABLE `usage_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`date` text NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_usage_stats_user_date` ON `usage_stats` (`user_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_usage_stats_user_date` ON `usage_stats` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `user_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_channels_user` ON `user_channels` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_channels_provider_external` ON `user_channels` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `user_subscriptions` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`plan_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `subscription_plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`timezone` text DEFAULT '' NOT NULL,
	`language` text DEFAULT '' NOT NULL,
	`onboarded` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
