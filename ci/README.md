# CI 与发布

此仓库按已提交的预编译运行文件分发，不在发布时临时拉取 DSH main 或重建不完整的上游源码。CI 验证真实包入口、相对依赖、客户端 loader 依赖、bundle patch、许可证、语法及现有离线测试；Mneme 另校验 src/lib 同步。

此导入快照缺少完整的上游构建输入，保留的旧 build 脚本不是本轮 CI 入口。普通打包不需要 CI fixture；不通过 prepare/prepack 钩子隐式构建或要求安装 ci/host，发布校验由 workflow 显式执行。

固定 Node 版本见 `.node-version`，npm 为 10.9.2。先运行 `npm ci --prefix ci/host --ignore-scripts`，再运行 `npm run ci:check`、`npm run ci:contract` 和 `npm run ci:test`。host fixture 固定官方 DSH 0.2.0-rc.2 及完整依赖锁，只有包导入冒烟，不代表完整 Agent/DSH 功能兼容已经验收，也不覆盖真实云服务或 GPU。

`main` push、PR 和手动触发执行 Windows/Linux 检查。发布需在 main 提交上创建与 package.json 完全一致的 `release-<version>` 或 `v<version>` tag；只有 CI 通过才创建 GitHub Release。不上传源码代替运行包，不发布 npm。SemVer 含预发布后缀（包括现有的 `-moe4all.1`）时标记为预发布，不伪装成稳定版。

发布产物为 `dsh-easyrewrite-moe4all.tgz`、`plugin-release.json` 和 `SHA256SUMS.txt`。清单记录包身份、版本、仓库、源码 commit、宿主声明、验证范围和包校验值；校验值不等于签名。脚本校验包内容与当前文件逐字节一致，并拒绝覆盖已有产物、错误 tag、路径越界或链接条目。

本机验证必须按工作区磁盘规则在 staging 快照中执行，测试数据和缓存定向到统一 local-work；不要在生产 profile 中安装 CI fixture。TTS 的 CI 使用模拟 Edge WebSocket 与本地 mock RVC，不下载模型，不启动真实推理服务。
