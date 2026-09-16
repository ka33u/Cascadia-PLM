# 第五轮备份恢复验证记录

2026-09-14。候选源码位于/tmp/cascadia-issue-review。本轮只增加运维脚本/测试和文档，不更改业务API、登录授权、原生权限、数据库结构或运行连接。

## 已执行验证

- /tmp/npi-recovery-final-tests.log：7项真实数据库/文件系统测试全部通过。随机创建源库和恢复库，覆盖快照期间改期/新上传、逐表摘要、原生项目/BOM/承诺读取及附件下载、损坏拒绝、路径/符号链接和元数据冲突、拒绝已有目标、失败标记以及无Vault设置分支。
- /tmp/npi-recovery-final-types.log：根脚本TypeScript检查通过；/tmp/npi-recovery-final-lint.log：新增/修改脚本静态检查零错误零警告。
- 实際运行库只读快照备份已完成：/Users/zhangyu/Documents/Cascadia-NPI/runtime/backups/npi-2026-09-14T08-16-14.608Z-b0efb51f。
- 快照事务开始：2026-09-14T08:16:14.619Z；PostgreSQL 16.13 (Homebrew)。
- 实际备份包含98张业务表、33条记录、0份Vault附件。当前运行库尚无业务附件，物理文件恢复由合成资料测试单独验证，不能以空附件库推断文件恢复已实测。
- 实际备份已恢复到新库 `cascadia_npi_restore_20260914_3da5f868`，98张表逐行摘要和Vault元数据均一致。
- 新库文件根目录：/Users/zhangyu/Documents/Cascadia-NPI/runtime/recovery-20260914_3da5f868/vault。恢复后才调整新库文件目录，由已有启用账号admin@npi.local记录审计归属。
- 验证报告：/Users/zhangyu/Documents/Cascadia-NPI/runtime/recovery-20260914_3da5f868/RESTORE_VERIFIED.json。

## 约束与范围

备份通过PostgreSQL重复读事务导出共享快照，pg_dump与表摘要/文件引用使用同一快照。每份文件按原生Vault哈希及大小验证，完成前只存在.pending目录，失败不发布完整备份。支持本地Vault，不默默跳过S3或缺失文件。

恢复只接受新命名的cascadia_npi_restore_*数据库和不存在的新目录，不使用--clean或覆盖原库。所有业务表先原样验证，再调整恢复环境的Vault设置。数据库CLI使用当前受控连接的权限；operator-email只指定审计账号，不授予应用权限。真实恢复库保留用于检查，未启动应用、未切换运行连接。

源代码/构建、环境配置、数据库服务账户另行保管；尚未启用自动调度、异盘副本、保留策略或加密归档。SHA-256用于完整性而非备份来源认证。大规模、跨平台、跨PostgreSQL主版本及S3恢复尚未验收。

第五轮收尾：7项测试进一步覆盖有效PNG照片的二进制还原，并将表摘要读取改为每次一行，控制含Base64原件的大行内存占用；最终测试记录为/tmp/npi-recovery-complete-tests.log。正式目录此前已通过备份完整性校验和7项数据库恢复测试。

类型检查环境说明：默认根检查在读取带“ 2”后缀、标记compressed,dataless的云端副本时阻塞，进程采样显示系统read等待。没有删除或改写这些文件，也没有改变项目tsconfig。已用临时配置排除这些未被实际应用引用的副本，对正式目录的当前应用文件及恢复脚本检查通过（/tmp/npi-recovery-canonical-types.log）。修改文件的静态检查在字节一致的校验副本运行，零错误零警告。默认全量检查仍需云端副本完成下载或由文件所有者整理后再运行，不能把临时校验说成这些副本已通过检查。
