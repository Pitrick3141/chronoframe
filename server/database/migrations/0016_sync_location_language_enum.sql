-- Keep existing D1 settings aligned with the shared five-language configuration.
-- zh-CN and zh both select Simplified Chinese for reverse geocoding.
UPDATE `settings`
SET `enum` = '["zh","zh-TW","zh-HK","en","ja"]',
    `value` = CASE WHEN `value` = 'zh-CN' THEN 'zh' ELSE `value` END,
    `default_value` = CASE
      WHEN `default_value` = 'zh-CN' THEN 'zh'
      ELSE `default_value`
    END
WHERE `namespace` = 'location' AND `key` = 'language';
