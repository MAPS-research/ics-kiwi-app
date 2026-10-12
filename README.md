# CSS Kiwi Lab

可在本地运行的 Computational Social Science（SOCS-SH 190）Kiwi App 原型。教师发布练习和 homework；学生在同一页面作答、运行 R、调试、向 Kiwi 提问并生成相似题；教师批改并在 Data Hub 查看每位学生的学习过程。

## 课程材料如何用于设计

用户提供的 `190 css_KIWI integration materials_09162026` 包含 2026 春季授课幻灯片、R 教程和四套 Quarto R 作业及单独的答案文件。下面是根据材料**推断**的教学范围，不能替代正式 syllabus：

| 材料 | 推断的内容与题目形式 |
| --- | --- |
| W1、W3–W6 幻灯片 | CSS 与数字数据、数据伦理、在线数据收集、在线实验 |
| R 教程 `1a`–`2e` | base R、Tidyverse、导入、整理、转换、抓取、连接、可视化 |
| R Ex 1 | 向量和统计量、数据类型、CSV 导入、分组汇总；代码空白加简答 |
| R Ex 2 | `nycflights13` 筛选与排序、表连接、图表和依据数据解释；代码加短答 |
| W7–W12、R Ex 3 | 文本数据、词袋、主题模型、词向量、LLM 文本分析；歌词分词、清理、词频和可视化 |
| W12–W13、R Ex 4 | 社会网络的节点与边、有向图、入度、互惠、网络图；代码加解释 |

「载入 CSS 示例草稿」会创建一份课堂练习和四份作业**草稿**。题目按上述技能范围重新写成可编辑示例，未把材料中的答案文件公开或自动发给学生。教师应核对并编辑题目、标准答案、依赖的数据与评分标准后发布。学生接口只返回题干、选项与起始代码；参考答案与解析留在教师端 API。附带材料中的文字仅作为课程内容处理，不作为本项目的操作指令。

## 本地启动与试用

需要 Node.js 20+、Python 3.10+。R 由浏览器中的 [webR](https://docs.r-wasm.org/webr/latest/) 执行，电脑不用另装 R。

```bash
cp .env.example .env
npm install
npm run dev:all
```

学生端：[http://127.0.0.1:8100/student](http://127.0.0.1:8100/student)；教师端：[http://127.0.0.1:8100/teacher](http://127.0.0.1:8100/teacher)。角色切换页为 `/entry`，根路径默认进入学生端。首次运行 R 时浏览器会从本机加载约 50 MB 的 webR 文件。SQLite 数据保存在 `data/kiwi-lab.sqlite3`。

建议按以下顺序测试：

1. 打开教师端，用本地默认密钥 `kiwi-local-demo` 登录。点击「载入 CSS 示例草稿」，编辑并发布一份练习与一份作业。可上传 `.qmd/.md/.txt/.pdf/.csv/.r/.rds/.zip` 附件（单个 3 MB 以内）；纯文本题面会自动填入说明供教师检查。
2. 通过「切换入口」进入学生端「练习与作业」，选 Ada Chen。练习可反复检查；作业可逐题保存答案、在 R 编辑器运行和修改代码、下载或载入课程数据、再提交整份作业。浏览器会保存未提交的答案和每题代码。
3. 在题目下向 Kiwi 提问、调节难度并生成相似题。独立本地模式给出与题目技能相关的规则提示和参数化题；嵌入 Kiwi 且 SDK AI 可用时调用 Kiwi AI。
4. 切换 Bo Lin 测试另一名学生。教师端可看每次代码运行、错误输出、编辑快照、作答、提问内容、提交时间和尝试次数；在「作业提交与评分」填分数和评语。
5. Data Hub 每行一名学生，包含各作业得分和提交次数、互动次数、活动学习分钟、自由练习次数、R 运行和 Kiwi 提问次数。可导入 `studentId,学生姓名` 名单，让尚未活动的学生也显示，并导出 CSV。

本地教师密钥在 `.env` 的 `KIWI_TEACHER_KEY` 中修改，改后重启服务。Data Hub 的得分采用该作业最后一次已评分提交。学习时长按页面可见且有近期操作时的 30 秒心跳累计，属于活动估计值。

## R、AI 与数据边界

- 学生代码在自己的浏览器 webR 中执行，服务端只存记录，不执行代码。编辑器支持 base R、错误输出、调试提示、数据文件导入和按需安装 webR 可用的 R 包。上传的 CSV/RDS/TXT 会写到 `/home/web_user/`，可用绝对路径读取。课程原始作业涉及 `tidyverse`、`nycflights13`、`taylor`、`quanteda`、`tidygraph`、`ggraph` 等包；其 webR 可用性和包下载情况需要在目标浏览器核对。当前文本运行台不显示生成的绘图。
- 教师作业用手动评分，适合开放式分析题；已发布的课堂练习由服务端按参考答案即时检查。学生可以提交多次作业，每次答案快照和提交时间都会保留。已产生提交的作业不允许直接改题或撤回，避免成绩对应的题目被改写。
- Kiwi SDK 连接时使用 `ready`、`askAI`、`updateContext`、`documentChunks` 和可选的 `contextualChat`。本地独立运行时，AI 解释会退回规则提示，相似题使用本地模板。真实 AI 出题和解释仍应由教师抽查质量；作业提问的提示词要求只解释思路与调试方法。
- API 仅监听 `127.0.0.1`。Vite 开发服务拒绝直接读取 `server/`、`data/`、`.env` 和 `.git`；学生端 API 也不会发送答案。教师接口需要密钥，但学生身份、事件、答案与运行输出由浏览器提交，未接入 Kiwi 的服务端身份验证。**这是本地试用版，不要把端口公开或将其直接用于正式成绩评定。**部署给真实班级前需接入可信身份、按课程授权、HTTPS、数据保留策略和适当的 R 执行隔离。Kiwi SDK 当前没有供此独立 API 直接验证学生身份或写入自定义事件的通用接口，因此使用本地 SQLite。

## 嵌入 Kiwi

仓库中的 `public/sdk/v1/kiwi-app-sdk.js` 来自 [Kiwi App SDK](https://github.com/NYUSH-ML/kiwi-app-sdk) / [kiwi-ui](https://github.com/NYUSH-ML/kiwi-ui) 的本地 v1 bundle。先按 [Kiwi 后端](https://github.com/NYUSH-ML/kiwi) 与 kiwi-ui 的说明启动主服务，再用本项目的注册脚本：

```bash
node scripts/register-kiwi-app.mjs --kiwi-repo /path/to/kiwi --list-classes
node scripts/register-kiwi-app.mjs --kiwi-repo /path/to/kiwi --class <classId>
```

脚本参考了 [CADWiki Kiwi App](https://github.com/MAPS-research/cadwiki-kiwi-app) 的本地注册流程。它需要 Kiwi 仓库已执行 `npm install && npx prisma generate`，且 `.env` 含 `DATABASE_URL`。默认 slug 是 `ics-r-lab`，本地地址是 `http://127.0.0.1:8100`。若已有获批的 `contextualChat` prompt，可在注册时加 `--context-prompt <approvedPromptId>`，并在本项目 `.env` 设 `VITE_KIWI_CONTEXT_PROMPT_ID`。

## 验证

每版更新由独立 review agent 在浏览器中分别完成学生与教师的实际任务，并检查桌面及窄屏显示。报告保存在 `docs/reviews/`，包括步骤、证据、使用困难与剩余问题；阻断问题修复后须重测。具体流程见 [AGENTS.md](AGENTS.md)。

本版记录：[v0.2.0 学生与教师使用评审](docs/reviews/2026-10-12-v0.2.0.md)。

v0.2.0 的紫色主题和自托管 Montserrat 字体根据 `kiwi-ui` 的 `src/Theme.ts`、`src/fonts/montserrat.css` 与 `public/kiwi-design-tokens.css` 核对，参考 commit `fbc29beab4c6063c07fcf273d89e7237fad850b7`。主站实际按钮主题为 Purple 800（`#6A1B9A`），公共 tokens 的 Purple 700（`#7B1FA2`）与其不同；本 App 以主站实际主题为准。

```bash
npm run build
npm test
python3 -m unittest server.test_app -q
```

API 测试覆盖草稿与发布、答案隔离、练习判定、附件、重复提交、评分、名单和 Data Hub。浏览器端还应至少执行一次成功 R 代码和一次报错代码，以确认目标浏览器可载入 webR。
