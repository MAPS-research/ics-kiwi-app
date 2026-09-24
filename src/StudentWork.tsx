import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, CircleHelp, Clock3, Code2, Download, LoaderCircle, Play, Sparkles } from 'lucide-react';
import { api } from './lib/api';
import { checkAnswer, generateQuestion, localSimilarQuestion } from './lib/questions';
import { debugHint, getRuntime, runR, type RunResult } from './lib/rEngine';
import type { Assignment, Course, Difficulty, EventRecord, KiwiClient, Question, Submission, WorkQuestion } from './types';

const label: Record<WorkQuestion['type'], string> = {
  choice: '选择题', fill: '填空题', predict: '代码预测', complete: '代码补全', text: '文字解释',
};

function localExplanation(question: WorkQuestion, error: string): string {
  if (error) return `先处理当前 R 报错：${debugHint(error)} 可以打印中间变量，确认数据类型和取值。`;
  const stem = `${question.prompt} ${question.starterCode}`.toLowerCase();
  if (/步长|seq\(/.test(stem)) return 'seq(from, to, by) 中，by 表示相邻元素之间增加多少。先列出前两项，检查差值。';
  if (/入度|提名|edgelist|edges/.test(stem)) return '入度只计算指向该节点的边。先检查边表的 to 列，再对目标节点计数。';
  if (/互惠|recipro/.test(stem)) return '互惠需要两个方向都存在。请区分对称的边结构与对关系原因的解释。';
  if (/文本|歌词|token|tolower|strsplit/.test(stem)) return '文本分析通常先规范大小写，再分词，之后清理标点和停用词。可以打印每一步的前几个结果。';
  if (/筛选|flights|jfk|ord/.test(stem)) return '把筛选条件逐个写成逻辑向量，用 & 连接；先查看每个条件分别匹配多少行。';
  if (/平均|均值|mean\(/.test(stem)) return '先按组筛选数值，再对筛选后的向量求均值。注意是否有 NA。';
  return '先找出题目的输入、处理和输出。运行最小的一段代码，再根据结果调整下一步。';
}

export function StudentWork({ classId, course, studentId, studentName, kiwi, events, track }: {
  classId: string; course: Course; studentId: string; studentName: string;
  kiwi: KiwiClient | null; events: EventRecord[];
  track: (type: string, payload: Record<string, unknown>, questionId?: string) => Promise<void>;
}) {
  const [works, setWorks] = useState<Assignment[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [practiceFeedback, setPracticeFeedback] = useState<{ correct: boolean; explanation: string } | null>(null);
  const [aiInput, setAiInput] = useState('');
  const [aiReply, setAiReply] = useState('');
  const [similar, setSimilar] = useState<Question | null>(null);
  const [similarAnswer, setSimilarAnswer] = useState('');
  const [similarResult, setSimilarResult] = useState<boolean | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>(2);
  const [packageName, setPackageName] = useState('');
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState('');
  const lastTrackedCode = useRef('');

  const selected = works.find(w => w.id === selectedId) || null;
  const current = selected?.questions[questionIndex];
  const mySubmissions = useMemo(() => submissions.filter(s => s.assignmentId === selectedId), [submissions, selectedId]);
  const refresh = useCallback(async () => {
    const [work, subs] = await Promise.all([api.work(classId), api.submissions(classId, studentId)]);
    setWorks(work); setSubmissions(subs);
  }, [classId, studentId]);
  useEffect(() => { void refresh().catch(e => setMessage(e.message)); }, [refresh]);
  useEffect(() => {
    if (!selectedId) return;
    const saved = localStorage.getItem(`kiwi-work-${classId}-${studentId}-${selectedId}`);
    try { setAnswers(saved ? JSON.parse(saved) : {}); } catch { setAnswers({}); }
    setQuestionIndex(0); setMessage(''); setSimilar(null); setAiReply('');
  }, [classId, studentId, selectedId]);
  useEffect(() => {
    const saved = current && selected ? localStorage.getItem(`kiwi-code-${classId}-${studentId}-${selected.id}-${current.id}`) : null;
    const initial = saved || current?.starterCode || '';
    setCode(initial); lastTrackedCode.current = initial;
    setRunResult(null); setPracticeFeedback(null); setSimilar(null); setAiReply(''); setAiInput('');
  }, [classId, studentId, selected?.id, current?.id, current?.starterCode]);
  useEffect(() => {
    if (!selected || !current || !code || code === lastTrackedCode.current) return;
    const timer = window.setTimeout(() => {
      lastTrackedCode.current = code;
      localStorage.setItem(`kiwi-code-${classId}-${studentId}-${selected.id}-${current.id}`, code);
      void track('code_edited', { assignmentId: selected.id, code, questionTitle: current.prompt }, current.id);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [code, selected, current, classId, studentId, track]);

  const setAnswer = (value: string) => {
    if (!selected || !current) return;
    const next = { ...answers, [current.id]: value };
    setAnswers(next); localStorage.setItem(`kiwi-work-${classId}-${studentId}-${selected.id}`, JSON.stringify(next));
    setPracticeFeedback(null);
  };
  const useCodeAsAnswer = () => { setAnswer(code); void track('work_answer_saved', { assignmentId: selectedId, questionId: current?.id, length: code.length }, current?.id); };
  const execute = async () => {
    if (!current || running) return;
    setRunning(true); setRunResult(null);
    const result = await runR(code);
    setRunResult(result); setRunning(false);
    await track('code_run', { assignmentId: selectedId, questionTitle: current.prompt, code,
      output: result.output, error: result.error || '', ok: result.ok, durationMs: result.durationMs }, current.id);
  };
  const check = async () => {
    if (!selected || !current) return;
    setBusy(true); setMessage('');
    try {
      const value = current.type === 'complete' ? code : answers[current.id] || '';
      const result = await api.checkPractice(classId, selected.id, { studentId, studentName,
        questionId: current.id, answer: value, runOutput: runResult?.output });
      setPracticeFeedback(result);
      await track('answer_submitted', { assignmentId: selected.id, title: current.prompt,
        questionType: current.type, answer: value, correct: result.correct }, current.id);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!selected) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.submitWork(classId, selected.id, { studentId, studentName, answers });
      await track('work_submitted', { assignmentId: selected.id, attempt: result.attempt, submissionId: result.id });
      await refresh(); setMessage(`第 ${result.attempt} 次提交成功：${new Date(result.submittedAt).toLocaleString('zh-CN')}。教师评分后可在此查看。`);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const ask = async () => {
    if (!current || !aiInput.trim()) return;
    setBusy(true);
    const prompt = aiInput.trim();
    const context = `课程：${course.title}；单元：${selected?.unitId}；题目：${current.prompt}；学生代码：${code.slice(0, 3000)}；运行错误：${runResult?.error || '无'}。`;
    let reply = localExplanation(current, runResult?.error || '');
    if (kiwi?.mode === 'live') {
      try { reply = await kiwi.askAI(`${context}\n学生问题：${prompt}\n请用中文解释思路和调试步骤，不直接给当前作业的最终答案或完整代码。`); }
      catch { /* local guidance remains available */ }
    }
    setAiReply(reply); setBusy(false);
    await track('ai_question', { assignmentId: selectedId, prompt, response: reply, questionTitle: current.prompt }, current.id);
  };
  const makeSimilar = async () => {
    if (!current || !selected) return;
    setBusy(true); setMessage(''); setSimilarResult(null); setSimilarAnswer('');
    try {
      const type = current.type === 'text' || current.type === 'complete' ? 'predict' : current.type;
      const next = kiwi?.mode !== 'live' ? localSimilarQuestion(current, selected.unitId, difficulty) : await generateQuestion({ course, unitId: selected.unitId, type, difficulty, events, kiwi,
        sourceQuestion: `${current.prompt}\n${current.starterCode}`, focusNote: `围绕这道题的技能生成不同数据、同样解法的巩固题：${current.prompt.slice(0, 300)}` });
      setSimilar(next); await track('similar_requested', { assignmentId: selected.id, sourceQuestionId: current.id,
        generatedQuestionId: next.id, difficulty, title: next.title }, current.id);
      await track('question_generated', { title: next.title, questionType: next.type, unitId: selected.unitId,
        source: next.source, relatedAssignmentId: selected.id }, next.id);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const download = async () => {
    if (!selected) return;
    const file = await api.attachment(classId, selected.id);
    const bytes = Uint8Array.from(atob(file.data), ch => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: file.type }));
    const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); URL.revokeObjectURL(url);
  };
  const loadData = async (file?: File) => {
    if (!file) return;
    if (!/\.(csv|rds|txt)$/i.test(file.name) || file.size > 10_000_000) {
      setRuntimeMessage('仅支持小于 10 MB 的 CSV、RDS 或 TXT 数据文件。'); return;
    }
    setRuntimeBusy(true); setRuntimeMessage('正在将文件载入浏览器 R 环境…');
    try {
      const name = file.name.replace(/[^A-Za-z0-9_.-]/g, '_');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const runtime = await getRuntime();
      await runtime.FS.writeFile(`/home/web_user/${name}`, bytes);
      const reader = /\.rds$/i.test(name) ? 'readRDS' : /\.csv$/i.test(name) ? 'read.csv' : 'readLines';
      setRuntimeMessage(`已载入 ${name}。在 R 中可用 ${reader}("/home/web_user/${name}") 读取。`);
      await track('work_answer_saved', { assignmentId: selectedId, action: 'data_file_loaded', fileName: name, bytes: bytes.length }, current?.id);
    } catch (e) { setRuntimeMessage(`载入失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setRuntimeBusy(false); }
  };
  const installPackage = async () => {
    const name = packageName.trim();
    if (!/^[A-Za-z][A-Za-z0-9.]{0,60}$/.test(name)) { setRuntimeMessage('请输入单个 R 包名，例如 dplyr。'); return; }
    setRuntimeBusy(true); setRuntimeMessage(`正在安装 ${name}，首次下载可能需要一些时间…`);
    try { const runtime = await getRuntime(); await runtime.installPackages(name);
      setRuntimeMessage(`${name} 已安装到当前浏览器 R 会话，可以在代码中使用 library(${name})。`);
      await track('work_answer_saved', { assignmentId: selectedId, action: 'package_installed', packageName: name }, current?.id);
    } catch (e) { setRuntimeMessage(`安装失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setRuntimeBusy(false); }
  };

  return <div className="student-content student-work">
    <section className="page-intro"><div><p className="eyebrow">CLASSROOM WORK</p><h1>课程练习与作业<span className="accent-dot">.</span></h1><p className="muted">完成教师布置的题目，运行 R 代码，记录每次尝试。遇到困难可向 Kiwi 提问，再做相似题巩固。</p></div><div className="session-meta"><Clock3 size={16} /> 学习过程已记录</div></section>
    <div className="work-layout"><aside className="panel work-selector"><div className="panel-heading"><div><p className="eyebrow">ASSIGNED</p><h2>已发布内容</h2></div><BookOpen size={17} /></div>
      {works.map(w => <button key={w.id} className={`work-select ${selectedId === w.id ? 'selected' : ''}`} onClick={() => { setSelectedId(w.id); void track('work_opened', { assignmentId: w.id, title: w.title }); }}>
        <strong>{w.title}</strong><small>{w.kind === 'homework' ? '作业' : '练习'} · {w.questions.length} 题{w.dueAt ? ` · 截止 ${new Date(w.dueAt).toLocaleDateString('zh-CN')}` : ''}</small></button>)}
      {works.length === 0 && <p className="empty-state">教师尚未发布练习或作业。</p>}
    </aside>

    <div className="work-main">{selected ? <>
      <section className="panel work-panel"><div className="question-topline"><span className="question-number">{selected.kind === 'homework' ? 'HOMEWORK' : 'PRACTICE'}</span><span className="small-pill">{selected.questions.length} 题</span></div>
        <h2>{selected.title}</h2><p className="work-instructions">{selected.instructions}</p>
          {selected.attachmentName && <div className="work-actions"><button className="outline-button" onClick={() => void download().catch(e => setMessage(e.message))}><Download size={14} /> 下载 {selected.attachmentName}</button>
            {/\.(csv|rds|txt)$/i.test(selected.attachmentName) && <button className="outline-button" disabled={runtimeBusy} onClick={() => void api.attachment(classId, selected.id).then(file => {
              const bytes = Uint8Array.from(atob(file.data), ch => ch.charCodeAt(0));
              return loadData(new File([bytes], file.name, { type: file.type }));
            }).catch(e => setRuntimeMessage(e.message))}>载入附件到 R</button>}</div>}
        {selected.kind === 'homework' && <div className="submission-status">{mySubmissions.length ? `已提交 ${mySubmissions.length} 次；最近提交 ${new Date(mySubmissions[0].submittedAt).toLocaleString('zh-CN')}` : '尚未提交'}
          {mySubmissions[0]?.grade !== null && mySubmissions[0]?.grade !== undefined && <strong> · 最近评分 {mySubmissions[0].grade} 分 · {mySubmissions[0].feedback || '无评语'}</strong>}</div>}
      </section>
      <section className="panel work-panel"><div className="work-question-tabs">{selected.questions.map((q, index) => <button key={q.id} className={questionIndex === index ? 'selected' : ''} onClick={() => setQuestionIndex(index)}>题 {index + 1}{answers[q.id]?.trim() ? ' ✓' : ''}</button>)}</div>
        {current && <><p className="eyebrow">{label[current.type]} · {current.points} 分</p><h2 className="work-prompt">{current.prompt}</h2>
          {current.type === 'choice' ? <div className="choices">{current.choices.map(choice => <button key={choice} className={`choice ${answers[current.id] === choice ? 'selected' : ''}`} onClick={() => setAnswer(choice)}>{choice}</button>)}</div> :
          current.type === 'text' || current.type === 'complete' ? <textarea className="work-answer" rows={current.type === 'complete' ? 6 : 5} value={answers[current.id] || ''} onChange={e => setAnswer(e.target.value)} placeholder={current.type === 'complete' ? '在 R 编辑器调试后，点击“将代码写入答案”，也可直接在此编辑。' : '写下你的解释、证据和思路…'} /> :
          <input className="answer-input" value={answers[current.id] || ''} onChange={e => setAnswer(e.target.value)} placeholder="输入答案…" />}
          {practiceFeedback && <div className={`feedback ${practiceFeedback.correct ? 'correct' : 'incorrect'}`}>{practiceFeedback.correct ? '正确。' : '继续尝试。'} {practiceFeedback.explanation}</div>}
          <div className="work-actions">{selected.kind === 'practice' && <button className="primary-button" disabled={busy} onClick={() => void check()}>检查练习答案 <ArrowRight size={15} /></button>}
            {selected.kind === 'homework' && <button className="primary-button" disabled={busy || selected.questions.some(q => !answers[q.id]?.trim())} onClick={() => void submit()}>提交整份作业 <ArrowRight size={15} /></button>}</div></>}
      </section>
      {current && <section className="panel work-panel"><div className="panel-heading"><div><p className="eyebrow">R PLAYGROUND</p><h2><Code2 size={18} /> 运行与调试</h2></div><span className="runtime-status">browser webR</span></div>
        <textarea className="work-code mono" spellCheck={false} value={code} onChange={e => {
          const value = e.target.value; setCode(value); setRunResult(null);
          localStorage.setItem(`kiwi-code-${classId}-${studentId}-${selected.id}-${current.id}`, value);
        }} aria-label="作业 R 代码编辑器" placeholder="在这里编写 R 代码…" />
        <div className="work-actions"><button className="run-button" disabled={running || runtimeBusy || !code.trim()} onClick={() => void execute()}>{running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />} 运行代码</button><button className="outline-button" onClick={useCodeAsAnswer}>将代码写入答案</button></div>
        {runResult && <div className="output-area"><div className="output-heading">控制台输出 · {runResult.durationMs} ms</div><pre className={runResult.ok ? '' : 'output-error'}>{runResult.output || runResult.error || '运行完成，无文本输出'}</pre>{!runResult.ok && <p className="debug-tip">{debugHint(runResult.error || runResult.output)}</p>}</div>}
        <div className="runtime-tools"><label>载入课程数据 <input type="file" accept=".csv,.rds,.txt" disabled={runtimeBusy} onChange={e => void loadData(e.target.files?.[0])} /></label>
          <label>安装 R 包 <input value={packageName} onChange={e => setPackageName(e.target.value)} placeholder="例如 nycflights13" /></label>
          <button className="outline-button" disabled={runtimeBusy || !packageName.trim()} onClick={() => void installPackage()}>安装</button></div>
        {runtimeMessage && <p className="runtime-message">{runtimeMessage}</p>}
      </section>}
      {current && <section className="panel work-panel"><div className="panel-heading"><div><p className="eyebrow">ASK KIWI</p><h2><CircleHelp size={18} /> 询问解释与巩固练习</h2></div><Sparkles size={17} /></div>
        <p className="muted">{kiwi?.mode === 'live' ? 'Kiwi 会结合题目和当前代码解释思路。作业模式下会避免直接给出最终答案。' : '本地模式提供与题目相关的规则提示；嵌入 Kiwi 后会回答你的具体问题。'}</p>
        <div className="ask-row"><input value={aiInput} onChange={e => setAiInput(e.target.value)} placeholder="例如：为什么我的筛选结果是空的？" onKeyDown={e => { if (e.key === 'Enter') void ask(); }} /><button className="primary-button" disabled={busy || !aiInput.trim()} onClick={() => void ask()}>提问</button></div>
        {aiReply && <div className="ai-reply">{aiReply}</div>}
        <div className="similar-controls"><label>相似题难度 <select value={difficulty} onChange={e => setDifficulty(Number(e.target.value) as Difficulty)}>{[1, 2, 3, 4, 5].map(level => <option key={level} value={level}>{level}</option>)}</select></label>
          <button className="outline-button" disabled={busy} onClick={() => void makeSimilar()}><Sparkles size={14} /> 生成相似题</button></div>
        {similar && <div className="similar-card"><strong>{similar.title}</strong><p>{similar.prompt}</p>{similar.code && <pre>{similar.code}</pre>}
          {similar.type === 'choice' ? <div className="choices">{similar.choices?.map(choice => <button className={`choice ${similarAnswer === choice ? 'selected' : ''}`} key={choice} onClick={() => setSimilarAnswer(choice)}>{choice}</button>)}</div> : <input value={similarAnswer} onChange={e => setSimilarAnswer(e.target.value)} placeholder="相似题答案" />}
          <button className="primary-button" onClick={() => { const result = checkAnswer(similar, similarAnswer); setSimilarResult(result);
            void track('answer_submitted', { title: similar.title, answer: similarAnswer, correct: result,
              questionType: similar.type, relatedAssignmentId: selected.id }, similar.id); }}>检查相似题</button>
          {similarResult !== null && <p>{similarResult ? `正确：${similar.explanation}` : '继续尝试，可在 R 编辑器里验证。'}</p>}
        </div>}
      </section>}
      {message && <p className="work-message">{message}</p>}
    </> : <section className="panel work-panel empty-work"><BookOpen size={27} /><h2>选择一份练习或作业</h2><p>题目、代码工作台和 Kiwi 提问会在这里显示。</p></section>}</div></div>
  </div>;
}
