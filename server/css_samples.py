"""Paraphrased CSS examples. Teacher-only drafts; never bundled in student JavaScript."""

SAMPLES = [
    {"kind": "practice", "title": "课堂练习 · R 基础与数据整理", "unitId": "r-basics", "instructions": "依据 R Ex 1 的技能范围编写的短练习。可反复尝试，并请求 Kiwi 解释。", "questions": [
        {"id": "p1", "type": "choice", "prompt": "R 中哪个表达式生成从 1 到 5、步长为 2 的向量？", "choices": ["seq(1, 5, by = 2)", "seq(1, 5, by = 1)", "c(1, 5)", "mean(1:5)"], "answer": "seq(1, 5, by = 2)", "explanation": "seq 的 by 参数控制步长。", "points": 5},
        {"id": "p2", "type": "predict", "prompt": "运行 x <- c(2, 4, 6); print(mean(x))，输出的数值是什么？", "starterCode": "x <- c(2, 4, 6)\nprint(mean(x))", "answer": "4", "explanation": "三个数之和为 12，除以 3 得 4。", "points": 5},
        {"id": "p3", "type": "complete", "prompt": "补全代码，让它输出 A 组的平均分。运行结果应为 [1] 80。", "starterCode": "group <- c(\"A\", \"B\", \"A\")\nscore <- c(70, 90, 90)\n# TODO: 计算 A 组平均分\nprint(avg_a)", "answer": "[1] 80", "explanation": "用 mean(score[group == \"A\"]) 计算。", "points": 10},
    ]},
    {"kind": "homework", "title": "作业 1 · R 基础、导入与整理", "unitId": "r-basics", "instructions": "参考课程 R Ex 1 的形式：写代码并简述思路。正式布置前，请教师按班级数据和评分标准修改。", "questions": [
        {"id": "h1a", "type": "complete", "prompt": "创建从 -3 到 25、步长为 2 的向量 x，打印平均值。", "starterCode": "x <- # TODO\nprint(mean(x))", "answer": "x <- seq(-3, 25, by = 2)\nmean(x)", "points": 8},
        {"id": "h1b", "type": "text", "prompt": "说明为什么导入社交媒体数据时，长数字 ID 应作为字符型读取。", "answer": "避免精度损失与无意义的数值运算。", "points": 8},
    ]},
    {"kind": "homework", "title": "作业 2 · 航班数据连接与可视化", "unitId": "data-wrangling", "instructions": "根据 R Ex 2 的技能范围：筛选、排序、连接、可视化。真实数据需要教师上传并由学生自行导入。", "questions": [
        {"id": "h2a", "type": "complete", "prompt": "给定简化航班表，筛选出从 JFK 出发且飞往 ORD 的记录，打印行数。", "starterCode": "flights <- data.frame(origin=c(\"JFK\",\"LGA\",\"JFK\"), dest=c(\"ORD\",\"BOS\",\"BOS\"))\n# TODO: 用 base R 筛选\nprint(nrow(selected))", "answer": "1", "points": 10},
        {"id": "h2b", "type": "text", "prompt": "连接航班表与飞机表时，为什么不能只因为两表都有 year 列就直接以 year 连接？", "answer": "两表中的 year 含义不同；应核对语义并选择 tailnum。", "points": 8},
    ]},
    {"kind": "homework", "title": "作业 3 · 歌词文本预处理", "unitId": "text-analysis", "instructions": "根据 R Ex 3 的技能范围：语料构建、分词、去标点/数字/停用词、按文档统计词频。原始作业使用 taylor 与 quanteda，浏览器运行前请教师核对所需包。", "questions": [
        {"id": "h3a", "type": "text", "prompt": "写出从歌词文本到每首歌高频词列表的主要处理步骤，并说明停用词的作用。", "answer": "构建语料、分词、清理标点数字、去停用词、按歌曲统计词频。", "points": 20},
        {"id": "h3b", "type": "complete", "prompt": "使用 base R 将一句英文歌词转小写并按空格切词，打印第一个词。", "starterCode": "line <- \"Hello Social World\"\n# TODO: lowercase and split\nprint(words[1])", "answer": "[1] \"hello\"", "points": 10},
    ]},
    {"kind": "homework", "title": "作业 4 · 社会网络与入度", "unitId": "network-analysis", "instructions": "根据 R Ex 4 的技能范围：节点/边表、有向图、入度与互惠关系解释。正式作业可上传班级模拟网络数据。", "questions": [
        {"id": "h4a", "type": "complete", "prompt": "边表中 to 表示被提名者。用 base R 统计节点 B 收到几次提名。", "starterCode": "edges <- data.frame(from=c(\"A\",\"C\",\"B\"), to=c(\"B\",\"B\",\"A\"))\n# TODO: 统计 B 的入度\nprint(indegree_b)", "answer": "2", "points": 10},
        {"id": "h4b", "type": "text", "prompt": "在有向提名网络中，A 提名 B 且 B 提名 A 代表什么结构？这能说明什么，又不能直接证明什么？", "answer": "互惠关系；可能反映相互认可，但不能单凭边推断因果或关系质量。", "points": 10},
    ]},
]
