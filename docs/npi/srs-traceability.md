# V1.4规格书、界面与验收证据对照

核查日期：2026-09-16。依据用户提供的《Cascadia NPI SRS V1.4 数据库 API BOM导入开发版》全文及图28-1。原件、提取文本、样本、源码和测试日志摘要见 [本次证据](srs-audit-verification.json)。本表是需求追踪表，不代替真实业务签收。当前完整接口37项及候选／实际整套桌面手机流程已通过，见[2026-09-16完整回归](full-regression.md)。以下“本次单元／DB”保留最初专项范围，当前全套结果以该记录为准。

## 导航与页面职责

图28-1有八个一级入口。第13、23章的“制造工作台”是制造人员的任务视角，对应一级入口“制造准备”；其核心是四节点回复、异常件及完成处理。首页驾驶舱汇总项目进度、待办与风险。

| 一级入口 | 当前内容                                                 | 规格依据            |
| -------- | -------------------------------------------------------- | ------------------- |
| 首页     | 六项KPI、项目进度、今日待办、风险预警；正常项目可折叠    | 13、19.1、28.1      |
| 新品项目 | 项目目录、阶段筛选、项目概览与详情                       | 5、19.2、28.2       |
| BOM管理  | 当前BOM、导入预览、完整树、历史版本与换版复核            | 6、19.3～19.4、28.3 |
| 制造准备 | 工艺、工装、零部件齐套、样机装配任务；回复日期、确认完成 | 9、13、19.6         |
| 采购管理 | 管理岗位采购清单；采购账号仅处理本人任务、回复和到货     | 12、19.7、23        |
| 报表看板 | 阶段分布、完成结果、今日变化及累计改期记录               | 图28-1、20          |
| 基础数据 | BOM导入模板、阶段及节点规则说明                          | 图28-1、19.3、41.7  |
| 系统设置 | NPI业务岗位、原生用户管理入口                            | 图28-1、23          |

八项为管理员视图；技术、制造、主管显示前六项，采购只显示本人采购入口。对应 [导航源码](../../packages/core/src/components/npi/navigation.ts)、[页面分工](navigation-alignment.md)及[历史实际构建浏览器证据](navigation-browser-verification.json)。项目内的制造准备页和齐套页底部集中回复使用同一业务计划，跨项目任务入口与项目详情各承担不同操作范围。

按用户明确决定，独立“新品例会”已取消，异常协调归首页。相似项目默认继承参数、当前BOM、重点跟踪配置和BOM外物料，重置承诺、完成和历史。“已满足／缺料”按跟踪物料完成／未完成计项，未跟踪当前BOM单列；不代表ERP库存。

## 证据口径

- **本次执行**：当前源码的26项单元测试全部通过，无跳过，包含两份真实ERP文件；新增数据库专项覆盖DB-01／DB-02，所有夹具在同一事务回滚并核对零残留。
- **历史执行**：保留适用的接口、组件及实际构建浏览器记录，明确其日期、文件和范围。历史完整API记录为36项；获本次明确授权后，当前37项完整重跑通过，历史记录仍保留原日期。
- **源码核对**：查明入口、规则及实现所在位置，不据此声称交互或接口再次通过。主管计划策略已按用户确认落实并通过专项；当前整体桌面／手机复验已通过，真实项目试运行按第18章作为推荐安排。

首次规格书对照核查仅交付文档和测试脚本，没有更改产品代码。随后已修复第47章的并发项目编号冲突，补充[限定专项与构建证据](project-code-conflict.md)。文件哈希只证明核对时的文件一致，不等于全部场景通过。

## 全文范围索引

| 章节                           | 对应实现或说明                                                                                                      | 状态与边界                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1～2 建设目标、V1边界          | [运行说明](README.md)、[当前状态](current-status.md)                                                                | 独立NPI；ERP实时库存、CAD/ECO和企业通知不在本期已交付范围                       |
| 3 角色                         | `service.ts`权限、导航及岗位设置                                                                                    | 主管仅计划调整通过专项；见[主管权限](supervisor-planning.md)                    |
| 4～5 阶段、主字段              | `domain.ts`、`project-profile.ts`、项目概览与计划交接                                                               | 五阶段和电机参数已实现；单元规则本次通过，完整业务签收待完成                    |
| 6～8 BOM、跟踪分离、BOM外物料  | `excel.ts`、`bom.ts`、`service.ts`、[物料类型](external-material-types.md)                                          | 两份真实样本本次解析通过；跟踪独立、三类外加物料有历史接口证据                  |
| 9～11 制造、承诺、齐套         | `domain.ts`、`service.ts`、制造回复和齐套组件                                                                       | 状态、承诺、预测本次单元通过；制造事务有历史API和专项浏览器证据                 |
| 12～13 两类工作台、驾驶舱      | [导航](navigation-alignment.md)、[到货范围](arrival-windows.md)、[首页完整浏览](dashboard-browsing.md)              | 功能入口已拆分；独立例会按用户决定取消                                          |
| 14 原生对象映射                | Program、Issue、Document/Vault及NPI专表                                                                             | 采用一对一Program扩展；Task、BOM原件存储有实现差异，见下文                      |
| 15～16 规则、V1验收            | 下方BR、UI及第49章表                                                                                                | 行数、层级、日期、预测有本次证据；当前完整HTTP与实际构建浏览器主流程通过                      |
| 17～18 优先级、成功标准        | [当前状态](current-status.md)、[试运行记录模板](pilot-acceptance.md)                                                | P0/P1主体有交付证据；3～5个真实项目试运行为第18章推荐项，不作为代码交付必备条件 |
| 19.1～19.8 页面交互            | [UI历史对照](ui-alignment.md)、[导航](navigation-alignment.md)、采购／制造回复、BOM外物料专项                       | 以图28-1和后续用户决定合并解释；专项交互通过不等于最终全页面签收                |
| 20 承诺历史                    | [项目历史](project-history.md)、[主管历史筛选](supervisor-history-verification.md)                                  | 完整历史、次数筛选及分页有专项证据                                              |
| 21 问题                        | 原生Issue、`issue-service.ts`、[问题权限](issue-permissions.md)、[交接并发](issue-handoff-concurrency.md)           | 原生状态流、责任和记录已实现；不是额外审批系统                                  |
| 22 手机                        | 导航、采购回复／到货、制造回复／完成等专项浏览器记录                                                                | 手机专项与当前实际构建全流程复验通过                                          |
| 23 权限按钮                    | `service.ts`、`file-service.ts`、`issue-service.ts`                                                                 | 主管可调整计划；承诺及完成由责任人办理，专项通过                                |
| 24～25 接口清单、对象          | [NPI路由](../../packages/core/src/server/routes/npi.ts)、[NPI schema](../../packages/core/src/lib/db/schema/npi.ts) | 核对当前入口与对象；不等同于逐字段契约一致                                      |
| 26 UI验收补充                  | 下方UI-01～10                                                                                                       | 单列历史证据和待验边界                                                          |
| 27 开发顺序                    | 本页及当前交付记录                                                                                                  | 推荐顺序，不是功能验收项                                                        |
| 28～29 视觉原型、四页面主线    | 上方八入口、[导航](navigation-alignment.md)、[齐套导出](kit-export.md)                                              | 不要求逐像素复刻；主线为首页→项目→BOM→齐套                                      |
| 30～32 技术底座、复用、BOM模型 | 运行说明、schema及解析服务                                                                                          | 保留原生对象身份；若要求完全采用建议列布局，仍需单独设计评审                    |
| 33～34 页面及API路径建议       | `routes/npi/index.tsx`、`NpiWorkspace.tsx`、NPI路由                                                                 | 当前以`/npi`承载模块及详情；未逐一建立建议中的独立前端URL                       |
| 35～36 预测、权限              | domain及服务权限；下方KIT和API项                                                                                    | 规则本次通过；主管仅计划权限专项通过                                            |
| 37～38 难度、开发包            | 当前源码与交付记录                                                                                                  | 建议性工程组织，未作为功能通过数量                                              |
| 39～40 MVP、复用结论           | 下方主流程与交付清单                                                                                                | 合成主流程有历史证据；真实新品试运行待进行                                      |
| 41.1～41.7 数据结构            | schema、迁移、下方DB测试与实现差异                                                                                  | DB删除保护和版本唯一本次通过；未声称数据库逐列等同建议模型                      |
| 42.1～42.5 导入规则            | `excel.ts`、`bom.ts`、`bom-quantity.ts`、[行校验API](bom-validation-api.md)                                         | 两份真实样本、层级、前导零、精确数量本次通过；版本事务用历史证据                |
| 43 跟踪建议                    | `bom-tracking.ts`、[模板维护](template-editor.md)                                                                   | 明确业务属性、层级和优先级本次单元通过；不按名称猜测新规格                      |
| 44.1～44.10 API契约            | 下方API对照                                                                                                         | 十个入口已存在；扩展版本参数及日期格式见下文                                    |
| 45～46 状态与算法              | `domain.ts`及本次单元测试                                                                                           | 完成优先、北京时间自然日、预测不完整和瓶颈通过                                  |
| 47 错误码                      | 下方十个错误码对照                                                                                                  | 区分解析预览诊断、提交失败和请求格式错误                                        |
| 48 事务并发                    | 下方四条不变量                                                                                                      | 用户明确授权后当前37项完整接口通过                                      |
| 49 命名测试                    | 下方14个测试编号                                                                                                    | 本次执行与历史证据分别记录                                                      |
| 50 交付物                      | 下方八类交付                                                                                                        | 代码／文档存在与最终验收分开                                                    |
| 51 结论                        | 当前状态及试运行模板                                                                                                | V1开发回归完成；真实业务签收与生产规模验收另行记录                                            |

本表提及的业务服务位于 [lib/npi](../../packages/core/src/lib/npi)，组件位于 [components/npi](../../packages/core/src/components/npi)。

## 核心业务规则

| 编号  | 实现及证据                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| BR-01 | 动态解析模板及层级；本次两份真实BOM分别47／56行，最大层级均为4；任意层级合成测试通过                                  |
| BR-02 | `npi_bom_items`与`npi_tracking_items`分离；schema及历史BOM跟踪接口证据                                                |
| BR-03 | BOM外采购件直接进入指定采购清单；[新增恢复](external-recovery.md)及历史E2E                                            |
| BR-04 | 制造四节点负责人随项目制造负责人；[四节点回复](manufacturing-quick-reply.md)、[集中完成](manufacturing-completion.md) |
| BR-05 | 首次承诺保留、改期原因、版本与历史；本次单元及历史API并发用例                                                         |
| BR-06 | `domain.ts`统一计算；本次完成／逾期／待回复／风险优先级测试                                                           |
| BR-07 | 待回复关键项使预测不完整；本次KIT单元及[预测提示](prediction-completeness.md)                                         |
| BR-08 | 明细预测超过制造承诺触发冲突；本次KIT单元、历史E2E及[瓶颈定位](bottleneck-focus.md)                                   |
| BR-09 | 默认不强制跟踪普通物料；本次第43章属性建议测试；未跟踪当前BOM单列                                                     |
| BR-10 | 六项KPI、风险、瓶颈可定位；本次驾驶舱筛选单元及历史首页／瓶颈浏览器证据                                               |

## UI-01～UI-10

以下专项保留原验证范围；当前整套界面已在实际构建复验通过，见[完整回归](full-regression.md)。

| 编号  | 对应界面与证据                                                                                                                          | 尚需注意                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| UI-01 | 首页异常排序、风险摘要、待办；[导航](navigation-browser-verification.json)、[完整浏览](dashboard-browsing-verification.json)            | 当前完整桌面／手机套件通过                     |
| UI-02 | 本次两份真实文件解析均通过；BOM预览／树有历史浏览器记录                                                                                 | 当前两份真实文件已经完整浏览器重新导入并验证原件 |
| UI-03 | 完整BOM、重点／异常与搜索；[BOM树契约](bom-tree-api.md)、历史BOM浏览器                                                                  | 当前实际构建整套通过                           |
| UI-04 | 四节点集中回复、逐项改期原因；[制造回复恢复](manufacturing-recovery-verification.json)                                                  | 使用隔离项目，未替代真人操作签收               |
| UI-05 | 采购手机回复、改期、到货；[采购回复](procurement-reply-verification.json)、[到货资料](procurement-receipt-verification.json)            | 专项记录均注明实际构建及清理范围               |
| UI-06 | 外加采购件保存与采购接收；[新增恢复](external-recovery-verification.json)                                                               | 同一表单可恢复请求；不是跨页面全局自动补偿     |
| UI-07 | 关键采购承诺改变预测；本次算法单元及历史API E2E                                                                                         | 是保存后刷新计算，不声称跨终端实时推送         |
| UI-08 | 齐套冲突及驾驶舱瓶颈；本次KIT单元、[瓶颈浏览器](bottleneck-browser-verification.json)                                                   | 制造整体承诺与明细预测并列                     |
| UI-09 | 首次／当前／修改次数、完整历史；[项目历史](project-history-verification.json)、[主管筛选](supervisor-history-browser-verification.json) | 历史不经UI物理删除；当前真实项目数据待核对     |
| UI-10 | 用户已取消独立例会入口；首页正常折叠、异常优先                                                                                          | 作为明确需求调整记录，不恢复重复菜单           |

## 第49章命名测试

单元脚本：[npi-unit.test.ts](../../scripts/npi-unit.test.ts)；历史API脚本：[npi-http.test.ts](../../scripts/npi-http.test.ts)。测试名称可以直接搜索定位。

| 编号     | 证据及范围                                                                                                                                                                                    | 本次状态                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| DB-01    | [npi-db-contract.test.ts](../../scripts/npi-db-contract.test.ts)：拒删有NPI档案的Program、被引用跟踪项／BOM、拒绝孤儿BOM；历史／BOM记录保留                                                   | 通过；单事务回滚，零夹具残留                           |
| DB-02    | 同脚本：重复项目/version拒绝，不同版本允许                                                                                                                                                    | 通过；约束名`npi_bom_program_version`                  |
| BOM-01   | `ERP sample: 161F1246BM0001.xlsx`、`ERP sample: 161H1866BM0001-M12x30.xlsx`                                                                                                                   | 通过；47／56行、16／23个一级件、4层及逐行父子层级      |
| BOM-02   | `hierarchy jumps and invalid quantity stop import`                                                                                                                                            | 通过；API诊断另有历史接口证据                          |
| BOM-03   | `BOM builds arbitrary depth, trims NBSP and preserves engineering codes and leading zeroes`；XLSX编码测试                                                                                     | 通过                                                   |
| BOM-04   | `Import replay refused; new BOM version preserves old trees and all promises`                                                                                                                 | 当前37项完整API通过                            |
| API-01   | `Change reason and optimistic concurrency preserve first date and exactly one winning history`；承诺单元                                                                                      | 单元与当前完整HTTP错误响应通过                   |
| API-02   | `Object permissions: procurement cannot read full project or edit another buyer/material`                                                                                                     | 当前37项完整API通过                            |
| KIT-01   | `kit predicts independently, tracks missing replies, excludes completed and assembly`                                                                                                         | 本次通过，缺关键承诺时不完整                           |
| KIT-02   | 同一KIT单元及历史外加采购E2E                                                                                                                                                                  | 本次算法通过，最晚承诺成为瓶颈                         |
| KIT-03   | 同一KIT单元及历史外加采购E2E                                                                                                                                                                  | 本次算法通过，明细与管理承诺冲突                       |
| STATE-01 | `completed > overdue > pending > risk; commitment day is not overdue`                                                                                                                         | 本次通过                                               |
| CONC-01  | 上述历史改期并发API，检查仅一个获胜历史；单元`versionCheck`                                                                                                                                   | 当前完整HTTP包含并发API，验证仅一个获胜历史                    |
| E2E-01   | 历史`E2E: project creation, BOM preview/import and original-file roundtrip`及`E2E: external purchase, buyer reply, manufacturing reply, incomplete prediction and bottleneck`连续使用同一项目 | 当前完整HTTP与实际浏览器通过；真实业务签收另行进行 |

DB-01选择阻止删除有NPI档案的Program，不是级联销毁历史。专项只检验数据库约束，不运行API或浏览器，不可代替E2E-01。

## 第44章API入口与兼容边界

以下路径统一加前缀`/api/v1/npi`。十个入口已在路由中核对；适用历史API测试覆盖主要行为，本次没有重新验证所有响应字段。

| 章节  | 方法与路径                              | 实现要点                                                                                    |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| 44.1  | `POST /projects`                        | 原生Program建项及四节点同事务；返回项目ID、编号、阶段                                       |
| 44.2  | `POST /projects/:id/bom/import-preview` | multipart、模板和母件校验；无效行返回可展示诊断且无可用令牌                                 |
| 44.3  | `POST /projects/:id/bom/import`         | 一次性服务器预览令牌；保存原件、版本、行及当前版本                                          |
| 44.4  | `GET /projects/:id/bom/tree`            | `importId`、`trackingOnly`及必要祖先；见[BOM树契约](bom-tree-api.md)                        |
| 44.5  | `PATCH /bom-items/:id/tracking`         | 责任、要求、重点与影响齐套；新增／修改携带当前版本                                          |
| 44.6  | `POST /projects/:id/external-items`     | 指定采购人、类型、要求日期；当前表单可带`requestId`恢复，见[新增恢复](external-recovery.md) |
| 44.7  | `POST /tracking/:id/promise`            | `expectedVersion`、首次保留、改期原因；不允许直接改历史字段                                 |
| 44.8  | `POST /tracking/:id/complete`           | 版本核对、同实际日期重复提交幂等；完成日期另有受控更正入口                                  |
| 44.9  | `PUT /projects/:id/manufacturing-plan`  | 计划版本及四节点逐字段比较；整批成功或回滚                                                  |
| 44.10 | `GET /projects/:id/kit-status`          | 要求／制造承诺／预测、不完整、瓶颈与预警                                                    |

接口相较示例扩展了`expectedVersion`等并发参数。业务日期接受YYYY-MM-DD或带时区ISO输入，统一保存并返回北京时间自然日；不是保留示例中所有时分秒。预览是可诊断的读取阶段，行错误不必让HTTP请求整体失败；正式导入拒绝错误数据。对外集成前仍需以当前请求／响应建立逐字段契约测试，不能直接照抄文档示例假定完全兼容。

## 第47～48章错误和事务

| 第47章业务码             | 当前对应行为／限制                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| INVALID_BOM_FORMAT       | 非法工作簿／缺文件为400；体积限制可为413；预览行诊断规则见[校验API](bom-validation-api.md)                                                  |
| INVALID_LEVEL_SEQUENCE   | 层级错误进入预览诊断；无效正式导入为400                                                                                                     |
| PROMISE_REASON_REQUIRED  | 改期无原因为400；本次单元及历史API证据                                                                                                      |
| INVALID_STATE_TRANSITION | 非法阶段或已完成项目写入等为400                                                                                                             |
| NPI_PERMISSION_DENIED    | 业务权限拒绝为403；历史采购／主管隔离证据                                                                                                   |
| PROGRAM_NOT_FOUND        | 项目不存在为404                                                                                                                             |
| TRACKING_ITEM_NOT_FOUND  | 跟踪项不存在为404                                                                                                                           |
| BOM_VERSION_CONFLICT     | 当前版本、令牌消费／过期等冲突为409                                                                                                         |
| DUPLICATE_PROJECT_CODE   | 建项预检查及真实数据库并发编号冲突统一为409；五请求专项通过，见[编号冲突专项](project-code-conflict.md)。其他唯一约束仍为`VERSION_CONFLICT` |
| VALIDATION_ERROR         | 字段校验默认422；无效JSON等请求格式错误为400                                                                                                |

以上是源码及历史证据核对，不声称本次把每个错误分支都经HTTP执行。

| 第48章不变量     | 证据                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| BOM确认单事务    | `confirmImport`事务；历史导入、换版和失效预览API测试                            |
| 承诺乐观锁       | `versionCheck`本次单元；历史两请求竞争仅一个获胜历史                            |
| 重复完成幂等     | 历史`Completion is idempotent and excludes finished bottleneck from prediction` |
| 令牌短期／一次性 | 30分钟、用户／项目／版本绑定；历史重放、草稿重新解析与消费测试                  |

## 第41章实现差异与第50章交付

当前模型保留Program唯一项目身份，在`npi_projects`一对一扩展保存高频业务字段。制造计划一项目一条，四节点日期放在关联Tracking记录；未另造四个原生Task。母件、模板和原始BOM行使用JSON快照，数量用精确十进制文本，业务日期用`date`。这些与第41章建议列布局有差别，不能称为逐列一致。

BOM原件字节和SHA随版本保存在数据库，没有转入Document/Vault；项目／物料／问题资料使用原生Document/Vault。资料支持PDF、PNG、JPEG、WebP及图28-1中的Word（.docx）、Excel（.xlsx）；[办公资料专项](office-files.md)验证上传、原件下载、归档与访问权限。Office在线编辑、旧版二进制格式、CAD仍未提供。当前不自动发送催办或企业通知。首页和多数列表虽然有前端分页，仍未完成全系统服务端分页或生产压力验收。

| 第50章交付物   | 当前证据                                                                                             | 验收边界                                           |
| -------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Drizzle schema | [schema](../../packages/core/src/lib/db/schema/npi.ts)、本次DB专项                                   | 实现差异如上；未逐列照搬建议                       |
| Migration      | [旧库升级证据](upgrade-verification.md)                                                              | 合成旧库含原生数据，未复制真实企业旧库             |
| Seed／基础配置 | [管理员说明](README.md)、默认ERP模板、岗位设置及五阶段规则                                           | 真实用户岗位需管理员配置；正式库未自动填充示例项目 |
| BOM解析        | 两份真实样本本次26项单元测试                                                                         | 不扩张为所有ERP格式兼容                            |
| API            | 上方44.1～44.10及当前37项接口测试                                                                    | 当前完整重跑通过；不扩张为穷尽全部分支   |
| 前端           | 导航、BOM、齐套、采购、制造各专项记录                                                                | 当前候选与实际构建整套桌面／手机通过                     |
| 测试           | 本次单元／DB、历史HTTP主流程及各专项浏览器                                                           | 不混算本次、历史和真实业务结果                     |
| 文档           | [运行与管理员](README.md)、[模板维护](template-editor.md)、[备份恢复](recovery.md)、本表与试运行模板 | 部署限本机验证；其他环境及真实项目需记录结果       |

开展第18章推荐的真实项目试运行时，按 [试运行记录模板](pilot-acceptance.md)记录结果；准备情况见 [只读快照](pilot-readiness-verification.json)。真实项目尚未提供不阻碍代码交付，代码与界面验收仍按明确需求和测试核对。当前交付状态以[完整回归](full-regression.md)及[当前清单](current-status.md)为准。历史截图和构建记录保留原日期，不作为当前全部页面已验收的证明。
