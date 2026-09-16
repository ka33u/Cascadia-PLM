# 第四轮附件权限与验证证据

测试时间：2026-09-14。候选源码：/tmp/cascadia-issue-review。正式系统：/Users/zhangyu/Documents/Cascadia-NPI/app。

## 范围
新增file-service、NpiFiles、3种归属的上传/列表/下载及原因归档；迁移0009仅添加NPI资料空间与关联表。复用原生Document/Vault，未更改原生权限、用户、项目成员或核心服务。

技术/制造负责人读写本人项目、跟踪和问题文件；主管只读；采购仅本人采购跟踪的附件读取/到货资料上传及本人问题照片，不可读项目资料列表、上传技术资料或归档。下载重新校验当前责任人，历史上传者无额外权限。项目完成、跟踪停止、问题关闭、用户停用均拒绝写入。项目资料Design为项目绑定的Engineering容器，采购作为首位上传人也不会得到Program/Design成员权限。

每个上传请求有账号绑定的幂等编号/请求哈希，项目锁序列化。真实字节由原生StorageFactory保存；Document、Vault元数据、NPI关联、原生审计和业务审计同事务。没有生命周期/分支权限绕过选项。原生Document默认生命周期仅在缺失时补齐，不覆盖配置。

## 已执行的验证
- 9项附件真实HTTP及PostgreSQL测试全部通过：/tmp/npi-files-http-final.log。覆盖桌面PDF原件、原生Document/commit/Vault关联/上传人/审计；同编号重试及并发；对象/岗位/主管/跨来源权限；采购第一次上传不增加Program权限；物料和问题交接后原上传人失去访问；伪装/超限文件；存储部分写入失败、原生Document插入后失败的回滚及字节清理；下载破坏校验；原因归档保留历史；完成/停止/关闭/停用。
- 原有16项HTTP回归全部通过：/tmp/npi-files-regression.log。
- 15项领域/Excel测试（包含用户两个真实文件只读）全部通过：/tmp/npi-files-unit-final.log。
- 最终生产构建成功：/tmp/npi-files-build-final.log。
- core/app/根项目类型检查通过：/tmp/npi-files-types-final.log。
- 本轮静态检查零错误零警告：/tmp/npi-files-lint-final.log。
- 正式构建真实Chrome测试通过：/tmp/npi-files-browser-final.log。技术建项、项目PDF上传下载、采购390px手机到货照片及真实图像解码、问题照片、原因归档和已归档文件可见；既有BOM换版/Issue关闭流程仍通过。

所有合成业务写入只发生在cascadia_npi_test，文件只写/tmp/npi-files-test-*和/tmp/npi-files-browser-*。运行库未灌入示例项目。正式集成前应先备份运行数据库，再按校验清单复制候选文件并应用0009；不改动旧新品开发仓库。

## 已知限制
BOM原始Excel仍在PG；首次失败可留下空资料Design。DB无法确认提交结果时不清理可能被引用的字节。仅PDF/PNG/JPEG/WebP，未实现HEIC/CAD/Office或病毒扫描。现有备份脚本只备份DB，运维说明明确需要同一停写时点的Vault副本；自动文件备份和恢复演练仍待完善。

第四轮集成确认：迁移前备份 `runtime/backups/npi-2026-09-14T06-52-57.832Z.dump` 已生成；正式目录0009迁移、构建、core/app/根类型检查、9项附件HTTP测试及实际登录烟测通过。只读界面收尾增加关闭问题后立即隐藏上传入口，并在状态变化后重新获取权限。

本机测试环境限制：Chrome在macOS内核退出状态可能长时间等待。浏览器测试先关闭测试HTTP服务和数据库连接，再终止本次创建的专用浏览器；10秒仍不返回则结束测试进程，保留真实断言成功/失败退出码并输出明确提示。未将此视为Chrome生命周期问题已修复。最终浏览器与烟测记录为 `/tmp/npi-files-browser-bounded.log` 和 `/tmp/npi-files-ui-bounded.log`，页面断言通过；测试进程不再无限等待。
