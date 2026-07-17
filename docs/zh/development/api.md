# API 文档

## R2 对象目录

`/api/objects` 是仅限管理员使用的接口，用于把非图片、非视频文件存入
`MEDIA_BUCKET` R2 绑定。只要文件扩展名或 MIME 类型中的任一项表明它是图片或
视频，请求就会被拒绝。

1. `POST /api/objects`，请求体为 `{ "filename", "contentType", "size" }`，
   创建 pending 状态的 D1 记录并返回原始 `PUT` 地址。
2. `PUT /api/objects/:objectId/upload` 向 R2 上传与声明大小完全一致的字节；
   `Content-Type` 应使用上一步返回的值。
3. `POST /api/objects/:objectId/finalize` 通过 R2 HEAD 获取权威元数据，并把
   大小、ETag、版本和上传时间写入 D1。
4. `GET /api/objects` 列出元数据；`GET /api/objects/:objectId` 查询单个对象，
   `DELETE /api/objects/:objectId` 则幂等删除它。

完成确认后，响应会包含 `downloadUrl`，由已有的 R2 流式、Range 下载路由提供。
