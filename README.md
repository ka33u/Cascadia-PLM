# Cascadia-PLM · 新品制造协同

New product introduction (NPI) collaboration system，基于 Cascadia PLM 开源底座开发的独立新品项目协同系统。技术、制造、采购围绕同一份项目计划维护承诺，主管查看风险并受控调整计划。

## 已实现

- 八个模块：首页、新品项目、BOM管理、制造准备、采购管理、报表看板、基础数据、系统设置；按岗位显示。
- 五阶段项目流程、相似项目继承、项目计划与负责人交接。
- 多模板 Excel BOM 导入、草稿、母件确认、多阶树、原件追溯、版本差异与换版复核。
- 制造四节点、采购手机回复与到货、BOM外物料、首次／当前承诺和完整改期历史。
- 齐套预测、待回复／风险／逾期、瓶颈定位、筛选导出、原生问题和附件资料。
- 主管只调整计划，承诺由责任人回复；改期与交接保留原因和审计。

![新品驾驶舱](docs/npi/screenshots/full-regression-dashboard-desktop.png)

## 本地开发

需要 Node.js 22+、npm 和 PostgreSQL。最近本机验证环境为 Node.js 25.6.1、PostgreSQL 16.13；上游环境建议见[原项目说明](docs/UPSTREAM_README.md)。

1. 克隆本仓库，安装依赖：

   ```sh
   git clone https://github.com/ka33u/Cascadia-PLM.git
   cd Cascadia-PLM
   npm ci
   cp .env.npi.example .env
   ```

2. 在 PostgreSQL 创建独立的 `cascadia_npi` 和 `cascadia_npi_test` 数据库，并在 `.env` 填写自己的连接信息及资料目录。测试库名称必须以 `_test` 结尾。

3. 初始化并启动：

   ```sh
   npm run db:migrate
   TSX_TSCONFIG_PATH=packages/core/tsconfig.json node --env-file=.env --import tsx scripts/npi-bootstrap.ts
   npm run dev:npi
   ```

4. 打开 `http://localhost:3410/npi`。初始化管理员为 `admin@npi.local`，随机密码保存在本机 `.npi-local/首次登录.txt`。在系统设置中为实际人员分配技术、制造、采购或主管岗位。

环境配置、账户密码、数据库、资料库、依赖和构建产物不包含在仓库中。详细运行、权限、升级及备份说明见[开发与运行说明](docs/npi/README.md)。

## 验证与文档

2026-09-16 本机验证：37项完整接口测试、实际构建的桌面与手机整套流程、两份真实ERP样本及5000行／8层BOM验证通过。该记录不等于GitHub Actions或其他部署环境已经验收。

- [当前交付状态](docs/npi/current-status.md)
- [规格书对照](docs/npi/srs-traceability.md)
- [完整回归记录](docs/npi/full-regression.md)
- [BOM模板维护](docs/npi/template-editor.md)
- [备份与恢复](docs/npi/recovery.md)

完整接口及浏览器套件会在独立测试库保留合成诊断数据。真实ERP样本文件不随代码提交；相关测试通过 `NPI_SAMPLE_DIR` 指定本机样本目录。历史验证文档中的 `/tmp` 日志路径指向当时验证机器，不是仓库附件。

首期不接ERP实时库存，不自动发送企业消息；这些扩展及真实项目试运行另行安排。

## 来源与许可

基于 [Cascadia-PLM/Cascadia-App](https://github.com/Cascadia-PLM/Cascadia-App)，源码基线 `2dcc8fb2100e8d3c2083cbb5275df3a8a2f25d55`。保留原作者版权标记并遵循 [AGPL-3.0](LICENSE)；原项目介绍保存在[上游说明](docs/UPSTREAM_README.md)。

上游示例镜像发布工作流仅允许在原上游仓库执行；本仓库推送不会向上游镜像仓库发布产物。
