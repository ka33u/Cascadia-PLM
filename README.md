# 新品协同

独立部署的新品开发协同系统。账号、岗位权限、项目、BOM、制造准备、采购、问题、附件和审计均由本仓库实现。

## 业务功能

- 八个导航模块：首页、新品项目、BOM 管理、制造准备、采购管理、报表看板、基础数据、系统设置；按岗位开放。
- 多层 ERP BOM 导入、模板配置、母件确认、草稿、原始 Excel 留存、版本对比与重点跟踪继承。
- 制造四节点、BOM 外物料、采购回复与到货、首次承诺留存、修改原因及完整历史。
- 主管调整计划与负责人；承诺和实际完成由责任人回复。计划变更包含预览、版本校验和审计。
- 齐套统计采用「跟踪物料已完成 / 未完成」，未跟踪 BOM 单列；首期不接 ERP 库存。
- 相似项目继承参数、当前 BOM、跟踪配置及 BOM 外物料；承诺、实际完成和历史重新开始。
- 独立问题状态流转、负责人交接、处理记录；按项目 / 物料 / 问题权限管理附件。
- 中文账号管理、密码登录、首次改密、停用、改岗、密码重置、登录锁定和账号审计。

## 本地启动

需要 Node.js 22.12+（推荐 24）与 PostgreSQL 17。

1. `npm ci`
2. 将 `.env.example` 复制为 `.env`，填写一个新建数据库的 `DATABASE_URL`、`BASE_URL`、管理员邮箱及唯一初始密码。
3. `npm run setup`：建立表结构、导入模板与首位管理员。重复执行保留现有账号和密码。
4. `npm run dev`：打开 <http://localhost:3410>。首次登录必须修改初始密码。

没有默认密码、公开注册或自动创建的演示账号。生产使用 `npm run build` 和 `npm start`；HTTPS 反向代理应与 `BASE_URL` 一致。

Windows PowerShell 复制配置：`Copy-Item .env.example .env`。npm 脚本不使用 Unix 环境变量赋值语法。

## 容器部署

在 `.env` 设置 `POSTGRES_PASSWORD`、`ADMIN_EMAIL`、`ADMIN_PASSWORD` 与 `BASE_URL` 后，运行 `docker compose up -d --build`。数据库密码建议使用足够长的随机字母数字串，避免 URL 保留字符。数据库和附件分别存储在持久卷中。

## 旧版迁移

新库使用独立的 18 张业务表，不能在旧库上直接执行新迁移。

按 [迁移与运维说明](docs/operations.md) 将账号、NPI 数据和附件导入新库。迁移只读旧库、要求新库无业务数据、校验记录数与附件 SHA-256，并整体提交数据库写入。旧登录会话不迁移，原密码可用于首次登录后改密。

## 验证

```text
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:smoke
```

设置独立、库名以 `_test` 结尾的 `TEST_DATABASE_URL` 后：

```text
npm run test:http
npm run test:auth
npm run test:files
npm run test:migration
npm run test:accounts-browser
npm run test:browser
```

业务浏览器回归使用已构建产物。测试数据留在测试库用于核对。真实 ERP 样本可通过 `NPI_SAMPLE_DIR` 指定，不进入代码仓库。GitHub Actions 在 Windows / Linux 验证干净安装、构建、别名模块唯一性和桌面 / 手机首屏，另外运行 PostgreSQL 接口回归。

架构、权限及验证范围见 [开发说明](docs/architecture.md) 和 [回归记录](docs/verification.md)。许可证为 AGPL-3.0-or-later，见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
