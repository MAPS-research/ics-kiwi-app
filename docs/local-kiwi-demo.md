> v0.5.0 update: Kiwi course cards now open CSS Lab, which has a Back to Kiwi button. Embedded users share verified Kiwi course identity; teachers need no additional Lab key. Teacher analytics imports native Kiwi scratchpad and lecture AI activity alongside Lab records. Follow [README](../README.md) and [integration architecture](architecture-v0.5.0.md) for current workflows. The v0.3 instructions/screenshots below are historical, including the old second teacher login.

# 本地 Kiwi + CSS App 演示

版本：v0.3.0。用于这台 Mac 上的测试和教师演示。

## 打开演示

在项目目录执行：

```bash
npm run demo:start
```

服务在后台运行，关闭终端不会结束服务。先启动 Docker Desktop。浏览器打开 [http://localhost:3001/login](http://localhost:3001/login)。

| 角色 | 登录邮箱 | 课程 App 地址 |
| --- | --- | --- |
| 学生 | `demo.student@css-kiwi.local` | [学生 CSS App](http://localhost:3001/local-css-demo/app/ics-r-lab) |
| 教师 | `demo.teacher@css-kiwi.local` | [教师 CSS App](http://localhost:3001/admin/app/ics-r-lab/class/local-css-demo) |

密码分别在项目 `.local/demo-credentials.json` 的 `student.password`、`teacher.password` 中。可以在编辑器中打开这个本地文件查看；不要在演示录像或共享屏幕上展示它。教师进入 CSS Teacher Workspace 后，还需输入 `.local/app-access.json` 中的 `teacherKey`，用于本地 App API 的教师管理权限。

从官方 Kiwi 课程 App 打开后，App 顶部应显示 **KIWI LIVE** 和真实登录账号。直接访问 `127.0.0.1:8100` 是独立模式，提供规则提示和本地模板；真实 AI 的演示入口为 `localhost:3001`。

## 建议演示顺序

1. 用教师账号登录，进入 `CSS · Local Integration Demo` 课程的 `CSS Teacher Workspace`。在「布置与批改」创建练习或作业，设置参考答案与分值后发布。预置的两份内容是 `Demo · R 基础与均值练习` 和 `Demo · CSS 数据分析作业`。
2. 登出，再用学生账号登录，打开同一课程中的 CSS App。在「练习与作业」选择已发布内容，答题、保存答案。
3. 在 R 运行台执行 `print(mean(c(60, 75, 90)))`，可看到真实 R 输出 `[1] 75`。再执行一段错误代码，观察错误并修改代码重新运行。R 由浏览器 webR 执行；首次载入需要片刻。
4. 向 Kiwi 提一个与当前题目、代码相关的具体问题。页面显示真实回答，并标注来源。切换相似题难度，生成一题、检查答案、点击「再练一题」继续。也可在自由练习中选择题型和难度生成题目。
5. 完成作业后提交。用教师账号重新打开 App，在「作业提交与评分」评分，进入 Data Hub 查看同一学生的各作业分数、尝试、运行、问答、活动学习时长和时间线。App 的逐题事件存于本地 SQLite；Kiwi 主站另有 AI 对话记录与模型用量。

测试账号共用一份本地课程。需要同时展示两种角色时，请使用不同浏览器或独立浏览器配置，以免同一个 Kiwi 登录会话互相覆盖。

## 启动、停止与数据

```bash
npm run demo:status   # 查看四个服务是否 ready
npm run demo:stop     # 结束本项目管理的服务与独立 Docker 容器
npm run demo:start    # 保留数据重新启动，并补齐 Demo 内容
npm run demo:seed     # 可选：补齐两份 Demo 内容和演示学生名单
```

| 服务 | 地址 / 端口 | 持久数据 |
| --- | --- | --- |
| 官方 Kiwi UI | `http://localhost:3001` | 浏览器登录会话 |
| 官方 Kiwi API | `http://localhost:3000` | PostgreSQL 演示卷 |
| CSS App UI | `http://127.0.0.1:8100` | 浏览器答案与代码草稿 |
| CSS App API | `http://127.0.0.1:8101` | `data/kiwi-lab.sqlite3` |
| PostgreSQL / Redis | `5433` / `6380` | Docker 命名卷 |
| MinIO / 控制台 | `9002` / `9003` | Docker 命名卷 |

服务只绑定本机地址。独立 Docker 项目名为 `css-kiwi-demo`；它使用不同端口，不会停止电脑上其他 Kiwi Docker 项目。停止和启动均保留数据库、账号、作业和成绩。私有日志位于 `.local/logs/`；提交截图或错误日志前应先检查是否含账号或其他秘密。

## 首次安装或更新测试 key

前提：macOS arm64/x64、Docker Desktop、Git、Node.js 20+、Python 3.10+。首次安装：

```bash
cp .env.example .env
```

在编辑器中填写 `.env` 的 `OPEN_AI_TEST_KEY`，再执行：

```bash
npm install
npm run demo:setup
npm run demo:start
```

已有 `.env` 时直接编辑，保留其中的配置。更换 key 或 `KIWI_DEMO_MODEL` 后执行 `demo:stop`、`demo:setup`、`demo:start`。setup 会保留演示密码、会话密钥和数据，并重新生成后端配置。默认模型为 `gpt-5.4-mini`；OpenAI key 只复制到忽略提交的 `.local/kiwi/.env`。不应添加到任何 `VITE_` 变量。

setup 下载官方 Node.js 24.21.0 并检查 SHA256。官方源码位于 `.local/kiwi`、`.local/kiwi-ui`，固定参考版本如下：

| 组件 | 固定 commit |
| --- | --- |
| NYUSH-ML/kiwi | `2fe8d2d331dc619a1e22fe2fa61df2758ba7b353` |
| NYUSH-ML/kiwi-ui | `fbc29beab4c6063c07fcf273d89e7237fad850b7` |

`scripts/local-kiwi/backend-patches.mjs` 会应用可重复的本地兼容修改：本机监听、无需外部网站的健康检查、邮件测试模式、按模型设置 reasoning 请求参数。演示版访问令牌有效期为一小时，避免官方 App 流式请求在原来的 60 秒令牌到期后直接失败；登录与问答流不进入通用响应日志。没有修改远程官方仓库。

`scripts/local-kiwi/frontend.mjs` 会应用布局兼容修改：320px 导航栏内容缩排以容纳退出按钮；嵌入 App 使用正常布局中的 Kiwi Chat 工具行，避免桌面和窄屏悬浮聊天按钮遮挡答题内容。颜色与字体沿用官方主题。

## 本版范围与限制

- 演示课程中已放入一份明确标为 Demo 的课程摘要和 8 个文档片段，便于验证 SDK 课程材料读取。完整 CSS 课件尚未导入官方 Kiwi；本版未启动 Unstructured 文档解析服务，因此官方主站上传材料后的自动解析不在本次演示范围。CSS App 内的作业附件使用它自己的本地 API。
- R 运行是真实的浏览器 webR。base R 均值、错误与调试可演示；绘图显示和课程全部外部 R 包仍需后续支持 / 验证。
- 教师 App 当前使用独立本地管理密钥；学生事件由浏览器提交到本地 API。真实 Kiwi 登录身份会显示在 App 中，但本地 API 尚未服务端验证 Kiwi App token。这份运行环境适合本机演示，正式成绩评定需要补齐后端身份与课程授权。
- 真实 AI 回答会使用 OpenAI 测试 key。生成题目已检查字段和可判定格式，内容、参考答案和教学难度仍应由教师抽查。

实际浏览器评审步骤、结果与剩余困难见 [v0.3.0 评审报告](reviews/2026-10-14-v0.3.0.md)。
