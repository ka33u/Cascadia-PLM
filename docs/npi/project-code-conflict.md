# 并发建项的编号重复提示

对应规格书第47章：相同项目编号被拒绝时返回HTTP 409及`DUPLICATE_PROJECT_CODE`。

## 变化

旧版在建项前查询到重复编号时正确返回“项目编号已存在”。如果多个请求同时通过检查，随后由数据库的`programs_code_unique`约束拒绝重复写入，接口却返回通用`VERSION_CONFLICT`，提示“编号或版本已存在，请刷新核对”。

当前NPI错误处理会检查真实数据库唯一约束名称。项目编号冲突统一返回：

```json
{ "code": "DUPLICATE_PROJECT_CODE", "error": "项目编号已存在" }
```

原始PostgreSQL错误和Drizzle包装在`cause`内的错误均支持；其他唯一约束仍沿用通用版本冲突，已有业务错误、权限检查和校验不变。没有改动项目创建事务、字段、角色或数据库结构。

## 验证方法与范围

专项脚本：[npi-project-code-http.test.ts](../../scripts/npi-project-code-http.test.ts)。仅允许显式配置的本机`_test`数据库；启动独立本机HTTP服务，建立三个临时账号。五次建项由两个技术账号发出，均使用同一随机项目编号。

测试在本进程中暂缓Program的插入构造器，让五个请求都完成真实的编号预检查，再放行真实PostgreSQL写入。没有模拟数据库结果、添加触发器或锁定整张表。

- 旧版复现：一条201、四条409，但四条错误码均为通用`VERSION_CONFLICT`；复现夹具已清理。
- 修复后：一条201、四条409，后者全部为`DUPLICATE_PROJECT_CODE`；仅一个Program、一个NPI扩展、一个计划、四个制造节点和一条建项动态。
- 已有编号被提前检查拒绝时也返回同样错误码；不同编号仍可正常建项。
- 测试进程内四个临时错误路由核对原始／包装错误及其他唯一约束，确保响应不泄露内部SQL诊断。这四项是错误边界控制，不冒充真实数据库并发证据。
- 无论成功或断言失败，脚本释放等待、等待活动请求结束，按本次UUID清理项目、节点、动态、会话、岗位和账号，并核对残留。历史测试数据保持原样。

执行结果、实际交付哈希、类型检查及构建记录见 [专项证据](project-code-conflict-verification.json)。本专项不运行完整`npi-http`，不替代BOM、浏览器或真实项目最终验收；完整套件此前被拒绝的执行仍待明确许可。

从独立系统的`app`目录执行：

```sh
NPI_PROJECT_CODE_TAG=local TSX_TSCONFIG_PATH=packages/core/tsconfig.json node --env-file=.env --import tsx scripts/npi-project-code-http.test.ts
```

结果写入`/tmp/npi-project-code-local-result.json`，夹具和清理记录写入`/tmp/npi-project-code-local-fixtures.json`；若上次夹具记录未清理，脚本会停止。重复执行同一个标签会覆盖该标签的结果文件，保留需要的历史证据后再运行。
