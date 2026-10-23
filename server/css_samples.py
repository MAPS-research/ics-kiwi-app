"""Starter assignments from the course template (owned by ASSESS) [NM44, AU-D1-15].

Editable English examples; teachers review them before publishing. ``key`` is stored as
``assignments.starter_key`` (dedupe); ``legacyTitles`` are titles v0.5.1 used for the same sample, so a course that
loaded the old examples is not offered duplicates. Questions use Question JSON v2 (§4.5.2): in-class explanations
are ``studentExplanation``; homework references are reference answers / grading rubrics for staff only.
"""

SAMPLES = [
    {
        "key": "inclass-r-basics",
        # S-m01: v0.5.1 English title and the earlier Chinese title of the same sample
        "legacyTitles": ["Class practice · R basics and data wrangling", "课堂练习 · R 基础与数据整理"],
        "kind": "practice",
        "title": "In-class exercise · R basics and data wrangling",
        "unitId": "r-basics",
        "instructions": "Short exercises covering R Ex 1 skills. Retry, inspect the output, and ask Kiwi about your reasoning.",
        "questions": [
            {
                "id": "p1",
                "type": "choice",
                "prompt": "Which R expression creates a vector from 1 to 5 with a step of 2?",
                "choices": [
                    "seq(1, 5, by = 2)",
                    "seq(1, 5, by = 1)",
                    "c(1, 5)",
                    "mean(1:5)",
                ],
                "answer": "seq(1, 5, by = 2)",
                "studentExplanation": "The by argument controls the interval.",
                "points": 5,
            },
            {
                "id": "p2",
                "type": "predict",
                "prompt": "What does the final print() output?",
                "starterCode": "x <- c(2, 4, 6)\nprint(mean(x))",
                "answer": "4",
                "acceptedAnswers": ["[1] 4"],
                "studentExplanation": "The sum is 12; dividing by 3 gives 4.",
                "points": 5,
            },
            {
                "id": "p3",
                "type": "complete",
                "prompt": "Calculate the mean score for group A. The output should be [1] 80.",
                "starterCode": 'group <- c("A", "B", "A")\nscore <- c(70, 90, 90)\navg_a <- ____\nprint(avg_a)',
                "answer": "80",
                "referenceCode": 'group <- c("A", "B", "A")\nscore <- c(70, 90, 90)\navg_a <- mean(score[group == "A"])\nprint(avg_a)',
                "expectedOutput": "[1] 80",
                "studentExplanation": 'Use mean(score[group == "A"]).',
                "hints": ["Select the scores of group A with a logical index.", "mean() of the selected scores gives the answer."],
                "points": 10,
            },
        ],
    },
    {
        "key": "homework-1-r-basics",
        "legacyTitles": ["作业 1 · R 基础、导入与整理"],
        "kind": "homework",
        "title": "Homework 1 · R basics, import, and wrangling",
        "unitId": "r-basics",
        "instructions": "Write code and explain your reasoning. Adapt the examples and grading rubric before publishing.",
        "questions": [
            {
                "id": "h1a",
                "type": "complete",
                "prompt": "Create a vector from -3 to 25 with a step of 2 and print its mean.",
                "starterCode": "x <- ____\nprint(mean(x))",
                "answer": "x <- seq(-3, 25, by = 2)\nprint(mean(x))",
                "referenceCode": "x <- seq(-3, 25, by = 2)\nprint(mean(x))",
                "expectedOutput": "[1] 11",
                "graderRubric": "Full marks for seq(-3, 25, by = 2) and a printed mean of 11.",
                "points": 8,
            },
            {
                "id": "h1b",
                "type": "text",
                "prompt": "Why should long numeric social media IDs be imported as character values?",
                "answer": "To avoid precision loss and meaningless arithmetic.",
                "graderRubric": "Mentions precision loss of long numbers and that IDs are labels, not quantities.",
                "points": 8,
            },
        ],
    },
    {
        "key": "homework-2-joins",
        "legacyTitles": ["作业 2 · 航班数据连接与可视化"],
        "kind": "homework",
        "title": "Homework 2 · Flight data joins and visualization",
        "unitId": "data-wrangling",
        "instructions": "Practice filtering, sorting, joins, and visualization. Upload any additional data needed by your class.",
        "questions": [
            {
                "id": "h2a",
                "type": "complete",
                "prompt": "Filter the simplified flight table for flights from JFK to ORD and print the row count.",
                "starterCode": 'flights <- data.frame(origin=c("JFK","LGA","JFK"), dest=c("ORD","BOS","BOS"))\nselected <- ____\nprint(nrow(selected))',
                "answer": "1",
                "expectedOutput": "[1] 1",
                "points": 10,
            },
            {
                "id": "h2b",
                "type": "text",
                "prompt": "Why should a flight table and aircraft table not be joined on year simply because both have that column?",
                "answer": "The columns have different meanings. Check semantics and consider tailnum as a key.",
                "points": 8,
            },
        ],
    },
    {
        "key": "homework-3-text",
        "legacyTitles": ["作业 3 · 歌词文本预处理"],
        "kind": "homework",
        "title": "Homework 3 · Lyrics and text preprocessing",
        "unitId": "text-analysis",
        "instructions": "Practice tokenization, punctuation and stop-word removal, and document-level term counts. Check package availability before assigning package-based work.",
        "questions": [
            {
                "id": "h3a",
                "type": "text",
                "prompt": "Describe the steps from raw lyrics to a list of frequent words for each song. Explain the role of stop words.",
                "answer": "Build a corpus, tokenize, clean punctuation and numbers, remove stop words, and count terms per song.",
                "points": 20,
            },
            {
                "id": "h3b",
                "type": "complete",
                "prompt": "Use base R to lowercase the lyric, split on spaces, and print the first word.",
                "starterCode": 'line <- "Hello Social World"\nwords <- ____\nprint(words[1])',
                "answer": "hello",
                "expectedOutput": '[1] "hello"',
                "points": 10,
            },
        ],
    },
    {
        "key": "homework-4-networks",
        "legacyTitles": ["作业 4 · 社会网络与入度"],
        "kind": "homework",
        "title": "Homework 4 · Social networks and in-degree",
        "unitId": "network-analysis",
        "instructions": "Work with node and edge tables, directed networks, in-degree, and reciprocity. Teachers may attach a simulated class network.",
        "questions": [
            {
                "id": "h4a",
                "type": "complete",
                "prompt": "The to column contains nominated nodes. Count the nominations received by B using base R.",
                "starterCode": 'edges <- data.frame(from=c("A","C","B"), to=c("B","B","A"))\nindegree_b <- ____\nprint(indegree_b)',
                "answer": "2",
                "expectedOutput": "[1] 2",
                "points": 10,
            },
            {
                "id": "h4b",
                "type": "text",
                "prompt": "If A nominates B and B nominates A, what network structure is present? What can and cannot be concluded?",
                "answer": "Reciprocity. It may reflect mutual recognition but does not establish causation or relationship quality.",
                "points": 10,
            },
        ],
    },
]
