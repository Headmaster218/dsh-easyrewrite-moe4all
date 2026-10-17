# CI 与发布

## 独立缓存与草稿验收

本仓保存与其他维护插件一致的本地缓存动作、脚本和测试，不依赖公共 CI 仓库。差异只写入 `ci/cache.json` 与 `ci/release.json`；公共实现的修订需同步到各仓并各自提交。

只缓存 npm 下载包。key 区分实现版本、系统、架构、Node/npm 及完整 lockfile 摘要，不包含 tag；成功的 main push/手动任务可保存，PR/tag 只恢复。缓存缺失或服务不可用时仍安装冻结依赖并执行全部测试，不缓存 node_modules、profile、凭据或模型。日志和任务摘要记录 key、hit、save。

手动从 main 运行 Release 只创建草稿；完整校验后由 GITHUB_TOKEN 创建新版本 tag，不会再次触发公开发布。已有 Release、错误版本或指向其他 commit 的 tag 均不覆盖。正常 tag push 仍按原流程公开发布；草稿验收后需显式公开同一份草稿，不重复推送 tag。草稿不进入 OTA。

本机运行 `node --test ci/dependency-cache.test.mjs ci/release-mode.test.mjs` 时必须设置隔离的 `MOE4ALL_CI_TEST_ROOT`。验收需核对 main 冷缓存写入、草稿任务命中、原有测试、下载包 SHA256/版本/commit；命中缓存不等于插件功能已经验收。

此仓库按已提交的预编译运行文件分发，不在发布时临时拉取 DSH main 或重建不完整的上游源码。CI 验证真实包入口、相对依赖、客户端 loader 依赖、bundle patch、许可证、语法及现有离线测试；Mneme 另校验 src/lib 同步。

此导入快照缺少完整的上游构建输入，保留的旧 build 脚本不是本轮 CI 入口。普通打包不需要 CI fixture；不通过 prepare/prepack 钩子隐式构建或要求安装 ci/host，发布校验由 workflow 显式执行。

固定 Node 版本见 `.node-version`，npm 为 10.9.2。先运行 `npm ci --prefix ci/host --ignore-scripts`，再运行 `npm run ci:check`、`npm run ci:contract` 和 `npm run ci:test`。host fixture 固定官方 DSH 0.2.0-rc.2 及完整依赖锁，只有包导入冒烟，不代表完整 Agent/DSH 功能兼容已经验收，也不覆盖真实云服务或 GPU。

`main` push、PR 和手动触发执行 Windows/Linux 检查。发布需在 main 提交上创建与 package.json 完全一致的 `release-<version>` 或 `v<version>` tag；只有 CI 通过才创建 GitHub Release。不上传源码代替运行包，不发布 npm。`-moe4all.N` 表示本发行版的正式修订，与 Agent 能力中心的通道规则一致；beta、rc、preview 等其他后缀仍标记为预发布。自 `moe4all.2` 修订起，默认正式通道即可发现这些插件更新，旧发布资产不覆盖。

发布产物为 `dsh-easyrewrite-moe4all.tgz`、`plugin-release.json` 和 `SHA256SUMS.txt`。清单记录包身份、版本、仓库、源码 commit、宿主声明、验证范围和包校验值；校验值不等于签名。脚本校验包内容与当前文件逐字节一致，并拒绝覆盖已有产物、错误 tag、路径越界或链接条目。

本机验证必须按工作区磁盘规则在 staging 快照中执行，测试数据和缓存定向到统一 local-work；不要在生产 profile 中安装 CI fixture。TTS 的 CI 使用模拟 Edge WebSocket 与本地 mock RVC，不下载模型，不启动真实推理服务。
