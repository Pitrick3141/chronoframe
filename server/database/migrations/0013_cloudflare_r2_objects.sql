CREATE TABLE `objects` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`expected_size` integer NOT NULL,
	`size` integer,
	`etag` text,
	`r2_version` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`uploaded_at` integer,
	`finalized_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_objects_r2_key` ON `objects` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `idx_objects_status_created_at` ON `objects` (`status`,`created_at`);
