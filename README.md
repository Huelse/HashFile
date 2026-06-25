# HashFile 文件哈希计算

在 fnOS 中计算文件或目录内的 SHA-256/SHA-512/SHA-1/MD5 哈希值，支持批量处理与校验比对

## 预览
<img width="1701" height="1114" alt="image" src="https://github.com/user-attachments/assets/8250916e-b028-43e8-ba19-3f8dfe56ad6a" />


## 说明

* `文件右键-详细信息-复制原始路径`粘贴到本应用路径输入框内即可计算
* 如提示无权限，请先在应用设置内添加文件夹**只读**权限
* `app/ui/config` 中添加 fileTypes 可右键打开方式并计算文件哈希值，例如：`"fileTypes": ["mp4", "mkv", "avi", "zip", "rar", "7z"]`
