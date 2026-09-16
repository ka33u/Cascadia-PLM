# 齐套瓶颈定位

规格书图28-1中的瓶颈提示和明细标记现可联动：点击“定位瓶颈”，物料定位到齐套明细；制造节点切换到“制造准备”并滚动、高亮对应行。“取消定位”恢复列表。

瓶颈采用服务端计算结果。预测完整时显示“当前瓶颈”；预测不完整时显示“已知瓶颈（预测不完整）”，避免将已知日期当作全部关键项的最终判断。没有瓶颈时不显示定位按钮。

Excel 齐套物料导出的 W 列新增“齐套瓶颈”，与页面使用同一标记。制造节点不属于物料导出清单。

统计口径保持：跟踪物料按实际完成／未完成计项，包括 BOM 外物料；未跟踪的当前 BOM 物料单列；制造节点不计入物料数量，也不代表 ERP 库存。

验证包含 2 项组件测试、2 项工作簿测试及独立 Chrome 的物料定位、取消定位、导出标记、手机制造节点定位。测试使用隔离 `_test` 数据库和合成项目，结果见 [浏览器记录](bottleneck-browser-verification.json)，截图见 [物料定位](screenshots/bottleneck-material.png)、[手机制造节点](screenshots/bottleneck-manufacturing-mobile.png)。本次不替代其他页面及真实业务验收。

在完成构建的项目根目录运行：

```sh
TSX_TSCONFIG_PATH=packages/core/tsconfig.json node --env-file=.env --import tsx scripts/npi-bottleneck-browser.test.ts
```

需显式配置以 `_test` 结尾的 `TEST_DATABASE_URL` 并安装 Chrome；测试使用独立无头浏览器与临时端口。

## 项目概览

规格书19.2要求概览异常摘要包含瓶颈。概览现复用同一服务端瓶颈数据，显示名称、负责人、承诺日期和预测完整性；“定位瓶颈”可进入齐套物料或制造节点。齐备时关键日期区显示“影响齐套的物料和节点均已完成”，不再同时要求取得承诺后计算。

新增4项概览DOM测试使用实际齐套计算函数产生状态，覆盖已知物料、制造节点、全部完成和未取得承诺。扩展独立浏览器测试覆盖概览桌面物料定位、手机制造节点定位和页面宽度；见 [验证结果](overview-browser-verification.json)、[桌面截图](screenshots/overview-bottleneck-desktop.png)、[手机截图](screenshots/overview-bottleneck-mobile.png)。截图使用合成测试项目。

预测不完整的具体原因已区分待回复和BOM换版待复核，见 [最新提示与截图](prediction-completeness.md)。本页较早截图保留原验证轮次文案。
