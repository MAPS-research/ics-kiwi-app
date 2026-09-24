import type { Course, Difficulty, EventRecord, Question, QuestionType, WorkQuestion } from '../types';
import type { KiwiClient } from '../types';

const random = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const qid = () => `q-${crypto.randomUUID()}`;
const format = (value: number) => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));

export function localQuestion(unitId: string, type: QuestionType, difficulty: Difficulty): Question {
  const n = random(2 + difficulty, 5 + difficulty * 3);
  const m = random(2, 3 + difficulty);
  const base = { id: qid(), type, difficulty, unitId, source: 'local' as const };
  if (unitId === 'text-analysis') {
    if (type === 'fill') return { ...base, title: '文本转小写', prompt: 'R 中把文本向量 words 转为小写，应使用哪个表达式？', answer: 'tolower(words)', explanation: 'tolower() 对字符向量逐项转小写。' };
    if (type === 'choice') return { ...base, title: '统计词频', prompt: '使用 base R，哪个表达式可以统计 tokens 中每个词的出现次数？', choices: ['table(tokens)', 'mean(tokens)', 'length(tokens)', 'sort(tokens)'], answer: 'table(tokens)', explanation: 'table() 生成每个取值的频数表。' };
    if (type === 'predict') return { ...base, title: '预测分词结果', prompt: '以下代码打印第几个词？请写出输出的单词。', code: 'tokens <- strsplit("digital social data", " ")[[1]]\nprint(tokens[2])', answer: 'social', acceptedAnswers: ['[1] "social"'], explanation: 'strsplit 拆分字符串后，[2] 取第二个词。' };
    return { ...base, title: '补全文本清理', prompt: '补全代码，将文本转小写后打印第一个词。', starterCode: 'line <- "Digital Social Data"\n# TODO: 创建 tokens\nprint(tokens[1])', answer: 'digital', expectedOutput: '[1] "digital"', explanation: 'tokens <- strsplit(tolower(line), " ")[[1]]。' };
  }
  if (unitId === 'network-analysis') {
    if (type === 'fill') return { ...base, title: '入度定义', prompt: '有向网络中，指向一个节点的边数称为该节点的什么？', answer: '入度', explanation: '入度是节点收到的有向边数量。' };
    if (type === 'choice') return { ...base, title: '互惠关系', prompt: 'A→B 且 B→A，在有向网络中称为什么？', choices: ['互惠关系', '孤立节点', '单向关系', '加权均值'], answer: '互惠关系', explanation: '两个方向都存在的边构成互惠关系。' };
    if (type === 'predict') return { ...base, title: '预测入度', prompt: '下列代码输出几？', code: 'to <- c("B", "A", "B", "C")\nprint(sum(to == "B"))', answer: '2', acceptedAnswers: ['[1] 2'], explanation: 'to 中有两条边指向 B。' };
    return { ...base, title: '补全入度计算', prompt: '补全代码，计算指向 B 的边数。', starterCode: 'to <- c("B", "A", "B", "C")\n# TODO: 创建 indegree_b\nprint(indegree_b)', answer: '2', expectedOutput: '[1] 2', explanation: 'indegree_b <- sum(to == "B")。' };
  }
  if (unitId === 'data-wrangling') unitId = 'dataframes';
  if (unitId === 'r-basics' || unitId === 'css-intro') unitId = 'basics';
  if (difficulty >= 4 && unitId === 'basics') {
    if (type === 'fill') return { ...base, title: '幂运算填空', prompt: '在 R 中，要计算 x 的三次方，空白处应该填什么表达式？', code: 'result <- ____', answer: 'x^3', acceptedAnswers: ['x ** 3'], explanation: '^ 表示乘方。' };
    if (type === 'choice') return { ...base, title: '先乘后减', prompt: `表达式 ${n} * 2 - ${m} 的结果是什么？`, choices: [String(2 * n - m), String(2 * n), String(2 * n - 2 * m), String(2 * n + m)], answer: String(2 * n - m), explanation: '先做乘法，再减去后面的数。' };
    if (type === 'predict') return { ...base, title: '追踪变量变化', prompt: '变量被重新赋值后，最后打印什么？', code: `x <- ${n}\nx <- x * 2\nprint(x - ${m})`, answer: String(2 * n - m), explanation: '第二次赋值覆盖了 x 原来的值。' };
    return { ...base, title: '补全平方和函数', prompt: '补全函数体，返回 a 的平方加 b。', starterCode: `calc <- function(a, b) {\n  # TODO: 返回 a^2 + b\n}\nprint(calc(${n}, ${m}))`, answer: String(n * n + m), expectedOutput: String(n * n + m), explanation: '函数体中写 a^2 + b 即可。' };
  }
  if (difficulty >= 4 && unitId === 'vectors') {
    if (type === 'fill') return { ...base, title: '条件索引填空', prompt: '从向量 x 中取出所有严格大于均值的元素，填入什么表达式？', code: 'above <- ____', answer: 'x[x > mean(x)]', explanation: '逻辑条件 x > mean(x) 会逐项产生 TRUE/FALSE，可用作索引。' };
    if (type === 'choice') return { ...base, title: '条件筛选求和', prompt: `x <- c(${n}, ${n + m}, ${n + 2 * m})。sum(x[x > ${n}]) 等于多少？`, choices: [String(2 * n + 3 * m), String(3 * n + 3 * m), String(n + m), String(n + 2 * m)], answer: String(2 * n + 3 * m), explanation: '只保留后两项，再把它们相加。' };
    if (type === 'predict') return { ...base, title: '预测逻辑索引', prompt: '预测打印的数字。', code: `x <- c(${n}, ${n + m}, ${n + 2 * m})\nprint(length(x[x > mean(x)]))`, answer: '1', explanation: '只有最后一项严格大于均值。' };
    return { ...base, title: '补全条件筛选', prompt: '补全 TODO，让 selected 只包含大于 scores 均值的元素。', starterCode: `scores <- c(${n}, ${n + m}, ${n + 2 * m})\n# TODO: 创建 selected\nprint(sum(selected))`, answer: String(n + 2 * m), expectedOutput: String(n + 2 * m), explanation: 'selected <- scores[scores > mean(scores)]。' };
  }
  if (difficulty >= 4 && unitId === 'conditions') {
    if (type === 'fill') return { ...base, title: '复合条件填空', prompt: '只有 x 非缺失且大于 0 才执行 if，应填什么条件？', code: 'if (____) print("positive")', answer: '!is.na(x) && x > 0', acceptedAnswers: ['!is.na(x)&&x>0'], explanation: '先排除 NA，再用 && 连接两个标量条件。' };
    if (type === 'choice') return { ...base, title: '向量化条件', prompt: 'ifelse(c(-2, 0, 3) > 0, "pos", "other") 返回什么？', choices: ['c("other", "other", "pos")', 'c("pos", "other", "pos")', 'c("other", "pos", "pos")', '"pos"'], answer: 'c("other", "other", "pos")', explanation: 'ifelse 对向量逐项判断，0 不大于 0。' };
    if (type === 'predict') return { ...base, title: '预测嵌套条件', prompt: '预测打印的内容。', code: `x <- ${n}\nif (x > ${n}) print("high") else if (x == ${n}) print("equal") else print("low")`, answer: 'equal', acceptedAnswers: ['[1] "equal"'], explanation: '第一个条件是严格大于，不成立；第二个相等条件成立。' };
    return { ...base, title: '补全缺失值处理', prompt: '补全函数，让 NA 返回 0，否则返回绝对值。', starterCode: 'safe_abs <- function(x) {\n  # TODO: 处理 NA，再返回绝对值\n}\nprint(safe_abs(NA))', answer: '0', expectedOutput: '0', explanation: '可先用 if (is.na(x)) return(0)，再用 abs(x)。' };
  }
  if (difficulty >= 4 && unitId === 'dataframes') {
    if (type === 'fill') return { ...base, title: '双条件筛选', prompt: '选出 df 中 group 为 A 且 score 大于 80 的所有行，应填什么？', code: 'selected <- ____', answer: 'df[df$group == "A" & df$score > 80, ]', explanation: '& 对每一行的两个条件做与运算；逗号后留空保留所有列。' };
    if (type === 'choice') return { ...base, title: '分组计算', prompt: '以下哪行代码计算 df 中 group 为 A 的 score 均值？', choices: ['mean(df$score[df$group == "A"])', 'mean(df$group == "A")', 'mean(df$score)', 'df$score == "A"'], answer: 'mean(df$score[df$group == "A"])', explanation: '先按 group 筛选 score，再求均值。' };
    if (type === 'predict') return { ...base, title: '预测分组均值', prompt: '预测打印的数字。', code: `df <- data.frame(group = c("A", "B", "A"), score = c(${n}, ${n + m}, ${n + 2 * m}))\nprint(mean(df$score[df$group == "A"]))`, answer: String(n + m), explanation: 'A 组是第一项和第三项，均值为中间数。' };
    return { ...base, title: '补全数据框筛选', prompt: '补全 TODO，让 high 包含 score 不低于 75 的所有行。', starterCode: 'df <- data.frame(score = c(60, 75, 90, 70))\n# TODO: 创建 high\nprint(nrow(high))', answer: '2', expectedOutput: '2', explanation: 'high <- df[df$score >= 75, ]。' };
  }
  if (unitId === 'conditions') {
    if (type === 'fill') return { ...base, title: '条件判断填空', prompt: '在 R 中，判断 x 是否严格大于 10，应在 if 的括号中填入什么表达式？', code: 'if (____) { print("high") }', answer: 'x > 10', explanation: '大于号是 >；if 条件需要返回 TRUE 或 FALSE。' };
    if (type === 'choice') return { ...base, title: '函数返回值', prompt: '下面函数在 f(-2) 时返回什么？', code: 'f <- function(x) { if (x > 0) x else -x }', choices: ['-2', '2', 'TRUE', '报错'], answer: '2', explanation: 'x 不大于 0，走 else 分支，-(-2) 等于 2。' };
    if (type === 'predict') return { ...base, title: '预测分支输出', prompt: '预测下列代码打印的内容。', code: `score <- ${n}\nif (score %% 2 == 0) print("even") else print("odd")`, answer: n % 2 === 0 ? 'even' : 'odd', acceptedAnswers: [n % 2 === 0 ? '[1] "even"' : '[1] "odd"'], explanation: '%% 是取余；余数为 0 时说明是偶数。' };
    return { ...base, title: '补全函数', prompt: '补全函数，让它返回向量中的正数个数。运行后应打印预期结果。', code: 'count_positive(c(-1, 2, 4, -3))', starterCode: 'count_positive <- function(x) {\n  # TODO: 返回正数的个数\n}\nprint(count_positive(c(-1, 2, 4, -3)))', answer: '2', expectedOutput: '2', explanation: '可用 sum(x > 0)；逻辑向量中 TRUE 按 1 计数。' };
  }
  if (unitId === 'dataframes') {
    if (type === 'fill') return { ...base, title: '数据框列选择', prompt: '要从数据框 df 中取出 score 这一列，请填入表达式。', code: 'scores <- ____', answer: 'df$score', acceptedAnswers: ['df[["score"]]', "df[['score']]"], explanation: '$ 可按列名从数据框中提取列。' };
    if (type === 'choice') return { ...base, title: '筛选行', prompt: '哪行代码能选出 df 中 score 大于 80 的所有行？', choices: ['df[df$score > 80, ]', 'df[df$score > 80]', 'df$score > 80', 'df[, df$score > 80]'], answer: 'df[df$score > 80, ]', explanation: '数据框索引是 [行, 列]，逗号后留空表示保留所有列。' };
    if (type === 'predict') return { ...base, title: '预测均值', prompt: '预测打印的数字。', code: `df <- data.frame(score = c(${n}, ${n + m}, ${n + 2 * m}))\nprint(mean(df$score))`, answer: String(n + m), acceptedAnswers: [`[1] ${n + m}`], explanation: '三个等差数的均值是中间数。' };
    return { ...base, title: '补全筛选', prompt: '补全 TODO，打印 score 大于 70 的行数。', starterCode: 'df <- data.frame(score = c(60, 75, 90, 70))\n# TODO: 将合格行放入 passed\nprint(nrow(passed))', answer: '2', expectedOutput: '2', explanation: 'passed <- df[df$score > 70, ]；70 本身不满足大于 70。' };
  }
  if (unitId === 'basics') {
    if (type === 'fill') return { ...base, title: '赋值运算符', prompt: '在 R 中，把数值赋给变量 total，最常用的赋值符号是什么？', code: 'total ____ 12', answer: '<-', explanation: 'R 中常用 <- 赋值。' };
    if (type === 'choice') return { ...base, title: '基础运算', prompt: `表达式 ${n} + ${m} * 2 的结果是什么？`, choices: [String(n + m * 2), String((n + m) * 2), String(n * m + 2), String(n + m)], answer: String(n + m * 2), explanation: '乘法优先于加法。' };
    if (type === 'predict') return { ...base, title: '预测输出', prompt: '预测下列代码打印的数字。', code: `x <- ${n}\ny <- ${m}\nprint(x + y)`, answer: String(n + m), acceptedAnswers: [`[1] ${n + m}`], explanation: `x + y = ${n + m}。` };
    return { ...base, title: '补全计算', prompt: '补全 TODO，使代码打印 a 与 b 的和。', starterCode: `a <- ${n}\nb <- ${m}\n# TODO: 计算 sum_value\nprint(sum_value)`, answer: String(n + m), expectedOutput: String(n + m), explanation: '可写 sum_value <- a + b。' };
  }
  if (type === 'fill') return { ...base, title: '向量索引填空', prompt: '在 R 中，想取出向量 x 的第 2 个元素，应填入什么表达式？', code: 'value <- ____', answer: 'x[2]', explanation: 'R 的索引从 1 开始。' };
  if (type === 'choice') return { ...base, title: '向量均值', prompt: `向量 c(${n}, ${n + m}, ${n + 2 * m}) 的均值是多少？`, choices: [String(n + m), String(n), String(n + 2 * m), format((n + m) / 3)], answer: String(n + m), explanation: '等差数列的均值是中间项。' };
  if (type === 'predict') return { ...base, title: '预测向量输出', prompt: '预测 print() 输出的数字。', code: `scores <- c(${n}, ${n + m}, ${n + 2 * m})\nprint(scores[2] + scores[3])`, answer: String(2 * n + 3 * m), acceptedAnswers: [`[1] ${2 * n + 3 * m}`], explanation: 'R 的索引从 1 开始；第 2、3 项相加。' };
  return { ...base, title: '补全向量计算', prompt: '补全 TODO，使用 mean() 打印 scores 的平均值。', starterCode: `scores <- c(${n}, ${n + m}, ${n + 2 * m})\n# TODO: 计算 avg\nprint(avg)`, answer: String(n + m), expectedOutput: String(n + m), explanation: '可写 avg <- mean(scores)。' };
}

export function localSimilarQuestion(original: WorkQuestion, unitId: string, difficulty: Difficulty): Question {
  const stem = `${original.prompt} ${original.starterCode}`.toLowerCase();
  const base = { id: qid(), difficulty, unitId, source: 'local' as const };
  if (/seq\(|步长/.test(stem)) {
    const start = random(1, 4), step = random(2, 2 + difficulty), end = start + step * 3;
    const answer = `seq(${start}, ${end}, by = ${step})`;
    return { ...base, type: 'choice', title: '相似题 · 向量序列', prompt: `生成 ${start}, ${start + step}, ${start + 2 * step}, ${end}，应使用哪个 R 表达式？`,
      choices: [answer, `seq(${start}, ${end}, by = 1)`, `c(${start}, ${end})`, `seq(${start}, ${end}, length.out = 2)`], answer,
      explanation: `从 ${start} 起，每次增加 ${step}，直到 ${end}。` };
  }
  if (/入度|提名|recipro|互惠|edges|edgelist/.test(stem)) {
    const count = random(2, 2 + difficulty);
    const to = [...Array(count).fill('B'), 'A', 'C'].join('", "');
    return { ...base, type: 'predict', title: '相似题 · 网络入度', prompt: '下面的有向边表中，B 的入度是多少？',
      code: `to <- c("${to}")\nprint(sum(to == "B"))`, answer: String(count), acceptedAnswers: [`[1] ${count}`],
      explanation: '每个 to == "B" 的 TRUE 都是一条指向 B 的边。' };
  }
  if (/词|lyrics|token|tolower|strsplit|文本/.test(stem)) {
    const word = ['social', 'digital', 'network'][random(0, 2)];
    return { ...base, type: 'predict', title: '相似题 · 文本预处理', prompt: '转小写并分词后，打印第一个词是什么？',
      code: `line <- "${word.toUpperCase()} data"\nwords <- strsplit(tolower(line), " ")[[1]]\nprint(words[1])`, answer: word,
      acceptedAnswers: [`[1] "${word}"`], explanation: '先 tolower，再 strsplit，取第一个元素。' };
  }
  if (/筛选|flight|jfk|ord|filter/.test(stem)) {
    const count = random(1, 1 + difficulty);
    const origins = [...Array(count).fill('JFK'), 'LGA'].join('", "');
    return { ...base, type: 'predict', title: '相似题 · 数据筛选', prompt: '下面有几条 JFK 出发的记录？',
      code: `origin <- c("${origins}")\nprint(sum(origin == "JFK"))`, answer: String(count), acceptedAnswers: [`[1] ${count}`],
      explanation: '比较每一行的 origin，TRUE 在 sum 中按 1 计数。' };
  }
  if (/平均|均值|mean\(/.test(stem)) {
    const start = random(10, 20), step = random(2, 2 + difficulty);
    return { ...base, type: 'predict', title: '相似题 · 分组均值', prompt: 'A 组两人的平均分是多少？',
      code: `group <- c("A", "B", "A")\nscore <- c(${start}, 99, ${start + 2 * step})\nprint(mean(score[group == "A"]))`, answer: String(start + step),
      acceptedAnswers: [`[1] ${start + step}`], explanation: '先选 A 组两项，再求均值。' };
  }
  return localQuestion(unitId, original.type === 'text' || original.type === 'complete' ? 'predict' : original.type, difficulty);
}

export function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/^\[1\]\s*/, '').replace(/^['"]|['"]$/g, '').replace(/\s+/g, '');
}

export function checkAnswer(question: Question, answer: string, runOutput?: string): boolean {
  if (question.type === 'complete') {
    if (!runOutput || !question.expectedOutput) return false;
    return normalizeAnswer(runOutput.split('\n').at(-1) || '') === normalizeAnswer(question.expectedOutput);
  }
  return [question.answer, ...(question.acceptedAnswers || [])]
    .some(expected => normalizeAnswer(expected) === normalizeAnswer(answer));
}

export function learningContext(events: EventRecord[]): string {
  const recent = events.slice(0, 25);
  const wrong = recent.filter(event => event.type === 'answer_submitted' && event.payload.correct === false);
  const failedRuns = recent.filter(event => event.type === 'code_run' && event.payload.ok === false);
  return `最近 ${recent.length} 次互动；答错 ${wrong.length} 次；运行报错 ${failedRuns.length} 次。` +
    (wrong.length ? ` 易错题型：${[...new Set(wrong.map(event => String(event.payload.questionType || '未知')))].join('、')}。` : '') +
    (failedRuns.length ? ` 最近错误：${String(failedRuns[0].payload.error || '').slice(0, 200)}。` : '');
}

function adaptiveLocalQuestion(unitId: string, type: QuestionType, difficulty: Difficulty,
  events: EventRecord[], focusNote = ''): Question {
  const recentWrong = events.filter(event => event.type === 'answer_submitted' && event.payload.correct === false)
    .map(event => String(event.payload.title || '')).join(' ');
  const focus = `${focusNote} ${recentWrong}`.toLowerCase();
  const base = { id: qid(), type, difficulty, unitId, source: 'local' as const };
  if (unitId === 'vectors' && difficulty <= 3 && /索引|下标|index/.test(focus)) {
    const second = random(5, 12 + difficulty * 2);
    if (type === 'choice') return { ...base, title: '索引专项练习', prompt: `x <- c(3, ${second}, 20)。x[2] 的值是什么？`,
      choices: [String(second), '3', '20', '2'], answer: String(second), explanation: 'R 从 1 开始编号；[2] 取第二项。' };
    if (type === 'complete') return { ...base, title: '补全索引代码', prompt: '补全 TODO，打印 scores 的第二个元素。',
      starterCode: `scores <- c(3, ${second}, 20)\n# TODO: 将第二个元素赋给 selected\nprint(selected)`,
      answer: String(second), expectedOutput: String(second), explanation: 'selected <- scores[2]。' };
  }
  if (unitId === 'conditions' && difficulty <= 3 && /缺失|na\b|missing/.test(focus)) {
    if (type === 'fill') return { ...base, title: '缺失值填空', prompt: '在 R 中判断 x 是否为缺失值，填入什么表达式？', code: 'missing <- ____',
      answer: 'is.na(x)', explanation: '不能用 x == NA 判断缺失；应使用 is.na()。' };
    if (type === 'choice') return { ...base, title: '缺失值判断', prompt: 'is.na(NA) 的结果是什么？', choices: ['TRUE', 'FALSE', 'NA', '报错'],
      answer: 'TRUE', explanation: 'is.na() 检查输入是否为缺失值。' };
    if (type === 'predict') return { ...base, title: '预测缺失值判断', prompt: '预测打印的内容。', code: 'print(is.na(c(1, NA, 3))[2])',
      answer: 'TRUE', acceptedAnswers: ['[1] TRUE'], explanation: '第二项是 NA，is.na() 对它返回 TRUE。' };
    return { ...base, title: '补全缺失值筛选', prompt: '补全 TODO，去掉缺失值后打印元素个数。',
      starterCode: 'x <- c(1, NA, 3)\n# TODO: 将非缺失元素赋给 clean\nprint(length(clean))',
      answer: '2', expectedOutput: '2', explanation: 'clean <- x[!is.na(x)]。' };
  }
  return localQuestion(unitId, type, difficulty);
}

export async function generateQuestion(input: {
  course: Course; unitId: string; type: QuestionType; difficulty: Difficulty;
  events: EventRecord[]; kiwi: KiwiClient | null; focusNote?: string; sourceQuestion?: string;
}): Promise<Question> {
  const { course, unitId, type, difficulty, events, kiwi, focusNote, sourceQuestion } = input;
  if (!kiwi || kiwi.mode !== 'live') return adaptiveLocalQuestion(unitId, type, difficulty, events, focusNote);
  const unit = course.units.find(item => item.id === unitId) || course.units[0];
  let materials = '';
  try {
    const result = await kiwi.documentChunks({ limit: 8 });
    materials = result.documents.flatMap(doc => doc.chunks.map(chunk => `${doc.fileName}: ${chunk.text}`)).join('\n').slice(0, 3500);
  } catch { /* material permission is optional */ }
  let privateContext = '';
  const promptId = import.meta.env.VITE_KIWI_CONTEXT_PROMPT_ID;
  if (promptId) {
    try {
      const result = await kiwi.contextualChat({
        promptId,
        contextRequest: { kind: 'student_learning_context', scope: 'current_user_current_class', include: ['recent_questions', 'weak_concepts'] },
      });
      privateContext = result.output.slice(0, 1200);
    } catch { /* prompt permission is optional */ }
  }
  const prompt = `你是 R 语言助教。请只输出一个 JSON 对象，不要 Markdown。为学生生成一道题。\n课程：${course.title}\n当前进度：${unit.title}；目标：${unit.goal}\n题型：${type}（fill=填空, choice=选择, predict=代码预测, complete=代码补全）\n难度：${difficulty}/5。\n学生学习情况：${learningContext(events)} ${privateContext}\n学生自述：${(focusNote || '暂无').slice(0, 400)}\n${sourceQuestion ? `相似题参考题干：${sourceQuestion.slice(0, 700)}。请保持核心技能和解法，替换具体数据与问法，不复用原题答案。` : ''}\n课程材料摘要：${materials || '暂无'}\nJSON 字段：title, prompt, code(可选), choices(选择题必须有 4 个字符串), answer(简短标准答案), acceptedAnswers(可选字符串数组), explanation, starterCode(补全题必须有可执行的 R 代码和 TODO), expectedOutput(补全题必须有运行后最后一行的确定输出)。题目必须可判定，R 代码只用 base R，不依赖外部包。不要包含学生身份信息。`;
  try {
    const answer = await kiwi.askAI(prompt);
    const json = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    if (!json || typeof json.title !== 'string' || typeof json.prompt !== 'string' ||
        typeof json.answer !== 'string' || typeof json.explanation !== 'string' ||
        (type === 'choice' && (!Array.isArray(json.choices) || json.choices.length !== 4 || !json.choices.includes(json.answer))) ||
        (type === 'complete' && (typeof json.starterCode !== 'string' || typeof json.expectedOutput !== 'string'))) {
      throw new Error('AI 题目格式不完整');
    }
    return { id: qid(), type, difficulty, unitId, source: 'kiwi-ai', title: json.title,
      prompt: json.prompt, code: json.code, choices: json.choices, answer: json.answer,
      acceptedAnswers: json.acceptedAnswers, explanation: json.explanation,
      starterCode: json.starterCode, expectedOutput: json.expectedOutput };
  } catch {
    return adaptiveLocalQuestion(unitId, type, difficulty, events, focusNote);
  }
}
