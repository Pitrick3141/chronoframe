ALTER TABLE `photos` ADD `cloudflare_stream_id` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `stream_status` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `stream_thumbnail_url` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `stream_dash_url` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `stream_duration` real;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_photos_cloudflare_stream_id` ON `photos` (`cloudflare_stream_id`);
