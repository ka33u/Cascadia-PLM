# 主管承诺历史专项验证

依据规格书20节：首次承诺永久保留，列表显示首次／当前承诺和修改次数，主管可按修改次数筛选风险任务。

本次检查现有功能，未调整业务代码或主管权限。独立无头Chrome使用主管账号，在实际构建应用中验证：

- 按项目关键词筛选承诺改期事项；阈值1、2、3次边界正确。
- 首次回复不计入改期次数；2次改期对应3条完整历史。
- 已完成事项默认排除，勾选“包含已完成／停止跟踪”后显示已完成事项；列表按改期次数降序排列。
- 从改期事项定位到项目物料；主管没有“调整计划”按钮，查看过程没有业务写入请求。
- 历史弹窗展示首次／当前承诺、每次改期日期、原因及修改人；390px手机视口无横向溢出或页面异常。

[桌面截图](screenshots/supervisor-history-desktop.png) · [手机历史截图](screenshots/supervisor-history-mobile.png) · [验证结果](supervisor-history-browser-verification.json)

夹具使用隔离_test库，由技术／制造测试用户创建和回复，主管只执行查询。本次包含已完成事项的筛选，不声称浏览器已覆盖停止跟踪事项；尚未确定的主管“授权调整”策略仍待业务决定。本次专项验证不代替整套页面和真实业务验收。

复验命令（已构建应用根目录，需Chrome与显式TEST_DATABASE_URL）：

```sh
TSX_TSCONFIG_PATH=packages/core/tsconfig.json node --env-file=.env --import tsx scripts/npi-supervisor-history-browser.test.ts
```

新测试脚本类型检查及ESLint通过；应用源码未变，沿用上一轮实际构建。
