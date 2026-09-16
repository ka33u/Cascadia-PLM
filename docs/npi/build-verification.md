# 完整构建恢复记录（2026-09-14）

标准命令 `npm run build` 已完整执行成功，退出码0，包含客户端、API、任务worker和第三方声明生成。未改动上游声明生成器或构建脚本，未跳过声明步骤。

## 根因与处理

诊断跟踪定位到声明生成器读取 `node_modules/convert-source-map/LICENSE 2` 后没有返回。进一步检查发现，依赖目录共有188个带数字后缀的许可类额外文件。

逐个读取本机npm缓存中的对应原始安装包，并验证其SHA-512与package-lock.json中的integrity一致。188个额外文件均不在相应安装包中；正式许可文件的SHA-256均与安装包原件一致。核对完成后，将额外文件移到以下本机诊断备份目录，未删除或覆盖正式许可文件：

`../runtime/diagnostics/notices-extra-files-20260914T143158Z/`

其中manifest.json记录原路径、文件元数据、原始安装包完整性标识、正式文件哈希及已移动清单。额外文件内容未被用于替代正式许可文本。源码目录中的其他编号文件不属于本次处理范围。

## 验证结果

- 原声明生成器正常完成，生成793个依赖包条目。
- `npm run build`：退出码0。
- `npm run license:thirdparty`：退出码0，沿用该检查脚本已有的例外记录；此结果是项目检查结果，不是新增的法律判断。
- `dist/cascadia/THIRD-PARTY-NOTICES.txt` 与 `.output/cascadia/THIRD-PARTY-NOTICES.txt`：均为1,475,538字节，SHA-256为 `62a1ad3f149e02efc15a55a689df857d5894f6bf928baf578e5707d248b313c7`。
- 使用完整构建产物运行浏览器回归：声明URL返回200、text/plain，响应与文件字节一致；BOM、草稿、相似项目继承、采购交接、问题/附件、制造节点、驾驶舱及手机流程通过，退出码0。
- 新增浏览器断言要求两处声明文件一致并可通过HTTP读取，避免后续只生成业务包而遗漏声明。

验证日志：`/tmp/npi-full-build.log`、`/tmp/npi-build-licenses.log`、`/tmp/npi-full-build-browser.log`。诊断证据：`/tmp/npi-notices-audit.json`、`/tmp/npi-full-build-artifacts.json`。上述临时文件不是长期运行所需配置。

## 后续使用

在app目录继续使用 `npm run build`，不再需要用于局部编译验证的临时脚本。若安装目录再次出现额外许可类文件，先按锁文件对应原始安装包核对，保留诊断备份；不要为了让构建通过而忽略所有数字后缀文件或删去许可内容。

本次未配置外网发布。真实人员及在研项目试运行仍待完成。“已满足/缺料”口径已由用户确认按跟踪物料实际完成／未完成统计，未跟踪当前BOM物料单列，见 [UI对齐清单](ui-alignment.md)。
