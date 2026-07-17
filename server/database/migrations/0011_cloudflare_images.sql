ALTER TABLE `photos` ADD `cloudflare_image_id` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_filename` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_mime_type` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_size` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_photos_cloudflare_image_id` ON `photos` (`cloudflare_image_id`);--> statement-breakpoint
CREATE INDEX `idx_photos_date_taken` ON `photos` (`date_taken`);--> statement-breakpoint
CREATE INDEX `idx_photos_storage_key` ON `photos` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_photos_source_filename` ON `photos` (`source_filename`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_queue_status_priority_created_at` ON `pipeline_queue` (`status`, `priority`, `created_at`);--> statement-breakpoint
CREATE INDEX `idx_album_photos_album_position` ON `album_photos` (`album_id`, `position`);--> statement-breakpoint
CREATE INDEX `idx_album_photos_photo_album` ON `album_photos` (`photo_id`, `album_id`);--> statement-breakpoint
DELETE FROM `album_photos`
WHERE `id` NOT IN (
  SELECT min(`id`) FROM `album_photos` GROUP BY `album_id`, `photo_id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_album_photos_album_photo` ON `album_photos` (`album_id`, `photo_id`);--> statement-breakpoint
DELETE FROM `photo_reactions`
WHERE `id` NOT IN (
  SELECT max(`id`) FROM `photo_reactions` GROUP BY `photo_id`, `fingerprint`
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_photo_reactions_photo_fingerprint` ON `photo_reactions` (`photo_id`, `fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_photo_reactions_fingerprint_created_at` ON `photo_reactions` (`fingerprint`, `created_at`);--> statement-breakpoint
CREATE INDEX `idx_photo_reactions_photo_type` ON `photo_reactions` (`photo_id`, `reaction_type`);
