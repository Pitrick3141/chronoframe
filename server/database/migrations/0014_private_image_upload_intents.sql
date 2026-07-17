CREATE TABLE `image_upload_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`expected_size` integer NOT NULL,
	`last_modified` text,
	`erase_location` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`image_id` text,
	`embedded_stream_id` text,
	`queue_task_id` integer,
	`actual_size` integer,
	`last_error` text,
	`expires_at` integer NOT NULL,
	`uploaded_at` integer,
	`finalized_at` integer,
	`failed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_image_upload_intents_image_id` ON `image_upload_intents` (`image_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_image_upload_intents_embedded_stream_id` ON `image_upload_intents` (`embedded_stream_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_image_upload_intents_queue_task_id` ON `image_upload_intents` (`queue_task_id`);
--> statement-breakpoint
CREATE INDEX `idx_image_upload_intents_creator_status_created_at` ON `image_upload_intents` (`creator_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_image_upload_intents_status_expires_at` ON `image_upload_intents` (`status`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_image_upload_intents_status_lease_expires_at` ON `image_upload_intents` (`status`,`lease_expires_at`);
