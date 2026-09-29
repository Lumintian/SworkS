# 测试用图片

`sample-p3.heic`：96×64 的渐变图（红色随 x 变化、绿色随 y 变化、蓝色 180），标注 Display P3 色彩配置，约 1.2 KB。
由本项目自行生成，与本仓库使用相同的许可证。

生成方法：

1. 用 sharp 生成原图并标注 P3：`sharp(raw, { raw: { width: 96, height: 64, channels: 3 } }).withIccProfile('p3').png()`；
2. 用 pillow-heif 1.8.0（内置 libheif 1.23 + x265）编码为 HEIC，并写入同一份 ICC：
   `Image.open(png).save('sample-p3.heic', quality=70, icc_profile=im.info['icc_profile'])`。

sharp 的预编译版不能编码 HEVC，所以测试里用这份提交的样本；其他格式（PNG、JPEG、AVIF）都在测试中现场生成。
