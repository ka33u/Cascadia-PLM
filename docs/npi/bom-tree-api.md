# BOM树读取契约

`GET /api/v1/npi/projects/{programId}/bom/tree?importId=...&trackingOnly=true`

省略`importId`读取当前生效BOM；指定版本必须属于该项目。省略`trackingOnly`等同`false`。查询只接受单个小写`true`或`false`，空值、重复参数和其他值返回422 `VALIDATION_ERROR`。

返回`importId`、`versionNo`、`nodes`和`rows`。没有当前BOM时版次标识为null，两个列表为空。`nodes`为带`children`的树；`rows`为同一批节点按原始行号排序的平铺表示。

每个节点/平铺行均包含布尔值`trackingEnabled`和`affectsKit`。按BOM行ID关联跟踪，不按编码或名称匹配；无关联时两者均为false。标记反映当前关联记录，历史BOM结构本身保持不变，不代表导入当日的跟踪状态快照。

- `trackingOnly=false`：完整指定版本BOM，包括未跟踪行。
- `trackingOnly=true`：重点跟踪标记为true的物料及其必要祖先。保留祖先是为还原父子关系，祖先自身的两个标记不会被改成true；无关兄弟和未被选中的子孙不返回。
- 只有`affectsKit=true`、`trackingEnabled=false`的物料不独立命中“重点跟踪”筛选；若是命中物料的祖先则作为上下文保留。这与页面“重点跟踪”筛选一致。齐套页“全部跟踪物料”的统计范围仍为启用跟踪或影响齐套的非制造物料，两个筛选用途不同。
- 已完成但仍启用重点跟踪的物料仍返回；停止重点跟踪的物料不独立命中。此接口不等同异常或未完成物料查询。
- 重导同编码BOM不会将旧版标记复制到新版；原跟踪经正式换版复核关联到新版后，按新的行ID关系读取。

权限沿用项目级读取：本项目技术/制造、主管、管理员；采购仍使用本人工作台，不能借助筛选参数读取整棵BOM。项目基线、版本、跟踪标记在同一个数据库只读可重复读事务中查询。

回归场景在`scripts/npi-http.test.ts`的“BOM tree contract...”用例：无BOM、无跟踪、深层祖先、同编码多位置、仅影响齐套、停止、完成、父节点不带出无关子节点、参数校验、角色权限、版本隔离和历史保留。此修复无数据库迁移，不修改已保存BOM或跟踪记录。
