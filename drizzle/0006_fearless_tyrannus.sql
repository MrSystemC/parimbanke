CREATE TABLE `event_categories` (
	`normalized_name` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `telegram_buy_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`telegram_id` text NOT NULL,
	`link_id` text NOT NULL,
	`event_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`total_cost` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "telegram_intent_quantity" CHECK("telegram_buy_intents"."quantity" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE INDEX `telegram_buy_intents_link` ON `telegram_buy_intents` (`link_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `telegram_link_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`telegram_id` text,
	`username` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_link_requests_code` ON `telegram_link_requests` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_link_requests_user` ON `telegram_link_requests` (`user_id`);--> statement-breakpoint
CREATE TABLE `telegram_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`telegram_id` text NOT NULL,
	`username` text,
	`linked_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_links_user` ON `telegram_links` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_links_telegram` ON `telegram_links` (`telegram_id`);