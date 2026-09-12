# Job Tracer Cloud

面向个人求职管理的云端版本。每个获批账号拥有独立工作区，投递、面试、面经、简历、招聘邮件、录音和项目档案互相隔离。

## 功能

- 管理投递、看板、面试日程、进度和复盘；
- 从文字或图片识别岗位信息，建立面经知识库并生成答案；
- 扫描 QQ、163 邮箱中的招聘通知，AI 复核后自动生成日程和推进投递状态；
- 上传简历、录音和项目 ZIP；项目档案仅建立只读索引，不会修改原仓库；
- AI 助教、面试准备 Agent、代码阅读 Agent，以及按工作区保存的 AI 调用审计；
- 账号申请须由平台管理员审批后才能登录。

## 服务器运行

需要 Node.js 24、PostgreSQL（含 pgcrypto、pgvector）和 Python 3.11/3.12（面试准备 Agent）。服务建议通过 systemd 运行，并由 Nginx 反向代理；Node 只监听 `127.0.0.1:3210`。

```bash
npm ci
npm run build
npm run db:migrate
npm start
```

真实配置写在服务器受保护的环境文件和 `config.json` 中，不能提交到 Git。参考 [`.env.example`](.env.example) 和 [`config.example.json`](config.example.json)。

首次平台管理员通过服务器终端创建：

```bash
npm run auth:bootstrap
```

该命令需要临时提供 `DATABASE_URL`、`BOOTSTRAP_ADMIN_EMAIL`、`BOOTSTRAP_ADMIN_DISPLAY_NAME` 和 `BOOTSTRAP_ADMIN_PASSWORD`。

## 数据备份

云端数据由 PostgreSQL、工作区私有文件、邮箱授权码加密文件和邮箱主密钥共同组成。加载服务器环境变量后执行：

```bash
npm run backup:cloud
```

脚本会在 `backups/` 创建带时间戳的私有备份目录；可用 `npm run backup:cloud -- --output /安全目录` 指定位置。备份中可能包含模型配置、加密邮箱授权文件和对应主密钥，必须存入加密且受访问控制的位置。数据库连接串不会写进备份。
