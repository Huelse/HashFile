# HashFile 文件哈希计算

在 fnOS 中计算文件或目录内的 SHA-256/SHA-512/SHA-1/MD5 哈希值，支持批量处理与校验比对

## 提醒

* 默认使用**root**权限方便读取，或者run-as改为"package"并在应用设置内添加文件夹只读权限
* `app\ui\config` 中添加 fileTypes 可支持右键打开并计算文件哈希值，如 `"fileTypes": ["md", "mp4", "mkv", "avi", "zip", "rar", "7z"]`
