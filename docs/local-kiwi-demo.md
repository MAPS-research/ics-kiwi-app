# 本地 Kiwi + CSS Lab 演示

版本：v0.6.0。用于这台 Mac 上的测试和教师演示。完整功能说明见 [README](../README.md)，设计见 [v0.6.0 架构说明](architecture-v0.6.0.md)，变更见 [CHANGELOG](../CHANGELOG.md)。

## 从 v0.5.1 升级到 v0.6.0（只需做一次）

首次以 v0.6.0 启动 App API 时会迁移 `data/kiwi-lab.sqlite3`；迁移前会自动在线备份到 `data/backups/`。建议另外手动备份一份：

```bash
npm run demo:stop                                  # 停止 Kiwi API/UI、App API（8101）与 App UI（8100）
mkdir -p data/backups
sqlite3 data/kiwi-lab.sqlite3 ".backup 'data/backups/kiwi-lab.manual-pre-0.6.0.sqlite3'"
# 在 .env 中设置 KIWI_TEACHER_KEY=<足够长的随机值>（例如 `openssl rand -hex 24` 的输出）；v0.6 不再提供默认 key
node scripts/local-kiwi/reinstall-bridge.mjs       # 复制 bridge controller、nest build、启动演示数据库容器、更新 App 配置与版本
npm run demo:start                                 # App API 迁移数据库（先备份），Kiwi UI 重新应用两个宿主补丁
curl -s http://127.0.0.1:8101/api/health           # 应显示 "version": "0.6.0"
npm run test:bridge                                # 可选：controller spec 与 bridge UI 测试
node scripts/local-kiwi/verify-integration.mjs     # 可选：对运行中的演示环境验证 bridge SQL
```

如果 App API 或 Vite 是自己用 `npm run dev:all` / `python3 server/app.py` 启动的，`demo:stop` 不会停止它们，需要先手动结束。回滚：停止服务，用 `data/backups/kiwi-lab.pre-0.6.0-001-columns-<时间>.sqlite3` 覆盖 `data/kiwi-lab.sqlite3`。

## 打开演示

```bash
npm run demo:start
```

服务在后台运行，关闭终端不会结束服务。先启动 Docker Desktop。浏览器打开 [http://localhost:3001/login](http://localhost:3001/login)。

| 角色 | 登录邮箱 | 入口 |
| --- | --- | --- |
| 学生 | `demo.student@css-kiwi.local` | [学生 CSS Lab](http://localhost:3001/local-css-demo/app/ics-r-lab) |
| 教师 | `demo.teacher@css-kiwi.local` | [教师 CSS Lab](http://localhost:3001/admin/app/ics-r-lab/class/local-css-demo) |

密码在 `.local/demo-credentials.json` 的 `student.password`、`teacher.password` 中；不要在录像或共享屏幕上展示该文件。从 Kiwi 打开时，Lab 服务端用 Kiwi App token 验证课程身份和角色，教师**不需要**第二个 key。Kiwi 中的助教（assistant）在 Lab 中是 TA（可以批改，不能改作业题目、设置和 AI 规则；决定 D1）。研究员（researcher，决定 D3）不由任何 Kiwi 角色自动映射：在 Course settings › Staff & roles 中给某位 Kiwi 课程成员设置 researcher 覆盖，或在独立模式下创建 researcher staff key。研究员只看到化名，导出总是化名、按研究同意过滤，且不能下载单个学生的案例文件。各项决定见 [v0.6.0 decisions](handoff/v0.6.0-decisions.md)。

直接访问 `127.0.0.1:8100` 是独立模式：学生用内置演示学生（`demo-ada`、`demo-bo`）或教师生成的 `#demo=` 链接；教师用 `.env` 中的 `KIWI_TEACHER_KEY` 或 Course settings › Staff & roles 中创建的 staff key。未设置 `KIWI_TEACHER_KEY` 时独立教师工作区不可用（`503 teacher_key_not_configured`）。API 直接从 `.env` 读取该变量；`demo:setup` 不再把它复制到 `.local/app-access.json`（没有程序读取这个文件；旧版本留下的副本可以删除）。

## 建议演示顺序

1. 教师登录后进入 **Home**：待批改、待发布、缺交（含“已开始”）、需要关注的学生、需要重讲的题目、学生问 AI 的内容。
2. **Assignments › New assignment**：填写题目、参考答案、评分要点（仅教师可见）和给学生的解释；在 Dates 设置截止与迟交规则；在 Student help 设置 Ask Kiwi 帮助程度（作业默认“只给提示”）；点 **Preview as student** 以学生视角试做（预览数据不计入统计），再 **Publish now**。
3. 学生登录，打开同一课程的 CSS Lab：答案边写边保存到服务器；在 R workspace 运行 `mean(c(60, 75, 90))` 会直接显示 `[1] 75`，`plot(1:3)` 会显示图形；在作业中向 Ask Kiwi 要最终答案，只会得到提示（服务器端的最终答案保护会改写或遮挡泄露的部分）。
4. 学生提交后，教师在 **Grading › To grade** 逐题打分和评语（自动判分已预填、迟交扣分自动计算），**Save & next** 保存草稿；在 **Release & export** 发布成绩，学生此时才看到成绩和逐题评语。
5. **Insights**：AI conversations（摘要与编码模式）、Activity explorer、Course metrics；**Students** 中打开学生档案和完整活动时间线（Lab 作业、自由练习、R 工作区、Kiwi 讲义阅读与 Kiwi lecture AI 对话在同一时间线中）。

需要同时展示两种角色时，请使用不同浏览器或独立浏览器配置，以免同一个 Kiwi 登录会话互相覆盖。

## 启动、停止与数据

```bash
npm run demo:status   # 查看服务是否 ready
npm run demo:stop     # 结束本项目管理的服务与独立 Docker 容器
npm run demo:start    # 保留数据重新启动，并补齐 Demo 内容
npm run demo:seed     # 可选：补齐 Demo 内容和演示学生名单
```

| 服务 | 地址 / 端口 | 持久数据 |
| --- | --- | --- |
| 官方 Kiwi UI | `http://localhost:3001` | 浏览器登录会话 |
| 官方 Kiwi API | `http://localhost:3000` | PostgreSQL 演示卷 |
| CSS Lab UI | `http://127.0.0.1:8100` | 浏览器中的事件发件箱（送达后清空） |
| CSS Lab API | `http://127.0.0.1:8101` | `data/kiwi-lab.sqlite3`（迁移前备份在 `data/backups/`） |
| PostgreSQL / Redis | `5433` / `6380` | Docker 命名卷 |
| MinIO / 控制台 | `9002` / `9003` | Docker 命名卷 |

服务只绑定本机地址。独立 Docker 项目名为 `css-kiwi-demo`，使用不同端口，不会停止电脑上其他 Kiwi Docker 项目。停止和启动均保留数据库、账号、作业和成绩。私有日志位于 `.local/logs/`；提交截图或错误日志前应先检查是否含账号或其他秘密。

## 首次安装或更新测试 key

前提：macOS arm64/x64、Docker Desktop、Git、Node.js 20+、Python 3.10+。

```bash
cp .env.example .env      # 在编辑器中填写 OPEN_AI_TEST_KEY 与 KIWI_TEACHER_KEY
npm install
npm run demo:setup
npm run demo:start
```

更换 key 或 `KIWI_DEMO_MODEL` 后执行 `demo:stop`、`demo:setup`、`demo:start`。setup 保留演示密码、会话密钥和数据，并重新生成后端配置；OpenAI key 只复制到忽略提交的 `.local/kiwi/.env`，不应添加到任何 `VITE_` 变量。setup 下载官方 Node.js 24.21.0 并检查 SHA256。官方源码位于 `.local/kiwi`、`.local/kiwi-ui`：

| 组件 | 固定 commit |
| --- | --- |
| NYUSH-ML/kiwi | `2fe8d2d331dc619a1e22fe2fa61df2758ba7b353` |
| NYUSH-ML/kiwi-ui | `fbc29beab4c6063c07fcf273d89e7237fad850b7` |

`scripts/local-kiwi/backend-patches.mjs` 应用可重复的本地兼容修改（本机监听、健康检查、邮件测试模式、reasoning 参数、演示令牌有效期）并安装 Lab bridge controller。`scripts/local-kiwi/frontend.mjs` 应用布局兼容修改和两个 v0.6 宿主补丁：

1. `kiwi:setChatAvailability`：作业的 Ask Kiwi 设为 Off 时，Lab 请 Kiwi 在该页面隐藏自己的聊天面板，离开页面后恢复；
2. 登录后返回原页面（`/login?returnTo=…`，只接受站内路径）。

两个补丁已获准用于本地演示（决定 D5），只会在部署步骤中装入本机 Kiwi，也就是在你同意重启本地服务之后运行 `reinstall-bridge.mjs` 和 `demo:start` 时。生产环境的 Kiwi 不应依赖本地补丁，需要由维护者在上游采纳；提案见 [open questions](handoff/v0.6.0-open-questions.md) 的 A2。

App 注册时把 Kiwi 自己的聊天设为 guidance 模式；若某课程在 Kiwi 中覆盖了该设置，`upgrade-integration.mjs` 会打印警告。远程官方仓库没有被修改。

## 本版范围与限制

- 课程身份：嵌入模式由服务端向 Kiwi 验证；独立模式的身份未经验证（研究导出会标记为演示数据）。
- Kiwi 身份边界：bridge 仍向 Lab 返回学生邮箱和名单（与 v0.5 相同），是否允许属于待 Kiwi 维护者回答的问题，见 [open questions](handoff/v0.6.0-open-questions.md)；已实现的备选方案是隐藏邮箱、按学生 id 导入姓名。
- 原生 Kiwi 活动只在有教师页面打开时同步（Kiwi 尚无课程级服务凭证）；Kiwi 端删除的数据不会自动传到 Lab。
- R 在浏览器 webR 中运行；课程允许列表中的 31 个包可按需安装。服务器不运行 R，代码题按学生自己的运行输出判分。
- 真实 AI 回答使用 OpenAI 测试 key；生成的题目经过格式、新颖性和最终答案检查，内容与参考答案仍应由教师抽查。
