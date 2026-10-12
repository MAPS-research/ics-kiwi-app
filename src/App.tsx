import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Code2, Command, GraduationCap, Lightbulb, LoaderCircle, Play, Plus, RotateCcw, Settings2, Sparkles, Terminal, Users, XCircle } from 'lucide-react';
import { TeacherDashboard } from './TeacherDashboard';
import { StudentWork } from './StudentWork';
import { KiwiBrand, RoleEntry, type AppRole } from './RoleEntry';
import { api } from './lib/api';
import { getKiwi } from './lib/kiwi';
import { checkAnswer, generateQuestion, learningContext, localQuestion } from './lib/questions';
import { debugHint, runR, type RunResult } from './lib/rEngine';
import type { Course, Difficulty, EventRecord, KiwiClient, Question, QuestionType } from './types';

const types: { id: QuestionType; label: string; short: string }[] = [
  { id: 'fill', label: '填空题', short: '填空' }, { id: 'choice', label: '选择题', short: '选择' },
  { id: 'predict', label: '代码预测', short: '预测' }, { id: 'complete', label: '代码补全', short: '补全' },
];
const defaultCode = 'scores <- c(72, 85, 91)\nprint(mean(scores))';
type RequestKind = 'generation' | 'hint' | 'run';
type RequestStamp = { id: number; contextRevision: number; contextKey: string; codeRevision: number };
type PracticeRunResult = RunResult & { code: string; stamp: RequestStamp };
const rolePaths: Record<AppRole, string> = { student: '/student', teacher: '/teacher', entry: '/entry' };
const roleFromPath = (): AppRole => {
  const pathname = window.location.pathname.replace(/\/+$/, '');
  return pathname === '/teacher' ? 'teacher' : pathname === '/entry' ? 'entry' : 'student';
};
const sessionId = (() => {
  const old = sessionStorage.getItem('kiwi-lab-session');
  if (old) return old;
  const id = `session-${crypto.randomUUID()}`;
  sessionStorage.setItem('kiwi-lab-session', id);
  return id;
})();

function Plot({ image }: { image: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
  }, [image]);
  return <canvas className="r-plot" ref={ref} aria-label="R 绘图结果" />;
}

function App() {
  const [kiwi, setKiwi] = useState<KiwiClient | null>(null);
  const [mode, setMode] = useState<'connecting' | 'live' | 'sim'>('connecting');
  const [apiOnline, setApiOnline] = useState(false);
  const [classId, setClassId] = useState('local-r-class');
  const [studentChoice, setStudentChoice] = useState(localStorage.getItem('kiwi-lab-student') || 'ada');
  const [focusNote, setFocusNote] = useState('');
  const [course, setCourse] = useState<Course | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [role, setRole] = useState<AppRole>(roleFromPath);
  const [teacherAuthenticated, setTeacherAuthenticated] = useState(false);
  const [teacherSection, setTeacherSection] = useState('teacher-overview');
  const [view, setView] = useState<'student' | 'work'>('work');
  const [unitId, setUnitId] = useState('data-wrangling');
  const [type, setType] = useState<QuestionType>('choice');
  const [difficulty, setDifficulty] = useState<Difficulty>(2);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<{ correct: boolean; text: string } | null>(null);
  const [hint, setHint] = useState('');
  const [code, setCode] = useState(defaultCode);
  const [runResult, setRunResult] = useState<PracticeRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [hintLoading, setHintLoading] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [generationError, setGenerationError] = useState('');
  const [activeTab, setActiveTab] = useState<'question' | 'editor'>('question');
  const lastSavedCode = useRef(defaultCode);
  const questionPanelRef = useRef<HTMLElement>(null);
  const generatorPanelRef = useRef<HTMLElement>(null);
  const unitSelectRef = useRef<HTMLSelectElement>(null);
  const revealNewQuestion = useRef(false);
  const contextRevision = useRef(0);
  const codeRevision = useRef(0);
  const requestIds = useRef({ generation: 0, hint: 0, run: 0 });
  const runInFlight = useRef(false);
  const mounted = useRef(true);

  const studentId = mode === 'live' && kiwi?.context?.userId ? kiwi.context.userId : `demo-${studentChoice}`;
  const studentName = mode === 'live' ? (kiwi?.context?.username || studentId) : studentChoice === 'ada' ? 'Ada Chen' : 'Bo Lin';
  const canTeach = mode !== 'live' || ['instructor', 'ta', 'admin', 'teacher'].includes(kiwi?.context?.userRole?.toLowerCase() || '');
  const accountName = role === 'teacher' ? (mode === 'live' ? kiwi?.context?.username || '课程教师' : '教师演示账户') : studentName;
  const currentUnit = course?.units.find(unit => unit.id === unitId);
  const progressIndex = course?.units.findIndex(unit => unit.id === course.currentUnitId) ?? 0;
  const contextSummary = useMemo(() => learningContext(events), [events]);
  const recentRuns = useMemo(() => events.filter(event => event.type === 'code_run').slice(0, 4), [events]);
  const contextKey = JSON.stringify([classId, studentId, role, view, unitId, type, difficulty, question?.id || null]);
  const currentContext = useRef({ key: contextKey, classId, studentId, role, code });
  currentContext.current = { key: contextKey, classId, studentId, role, code };
  const previousIdentity = useRef(`${classId}:${studentId}`);

  const beginRequest = (kind: RequestKind): RequestStamp => ({
    id: ++requestIds.current[kind], contextRevision: contextRevision.current,
    contextKey: currentContext.current.key, codeRevision: codeRevision.current,
  });
  const requestIsCurrent = (kind: RequestKind, stamp: RequestStamp) => mounted.current &&
    requestIds.current[kind] === stamp.id && contextRevision.current === stamp.contextRevision &&
    currentContext.current.key === stamp.contextKey && (kind !== 'run' || codeRevision.current === stamp.codeRevision);

  const invalidatePractice = ({ clearQuestion = false, resetCode = false, cancelGeneration = true } = {}) => {
    contextRevision.current += 1;
    codeRevision.current += 1;
    requestIds.current.hint += 1;
    if (cancelGeneration) { requestIds.current.generation += 1; setGenerating(false); }
    setHintLoading(false); setHint(''); setRunResult(null); setFeedback(null); setGenerationError('');
    revealNewQuestion.current = false;
    if (clearQuestion) { setQuestion(null); setAnswer(''); }
    if (resetCode) { setCode(defaultCode); lastSavedCode.current = defaultCode; }
  };

  const replaceCode = (next: string) => {
    codeRevision.current += 1;
    setCode(next); setRunResult(null); setFeedback(null);
  };

  const changeView = (next: 'student' | 'work') => {
    if (next === view) return;
    invalidatePractice();
    setView(next);
  };

  const navigateRole = (nextRole: AppRole) => {
    if (nextRole === role) return;
    invalidatePractice({ clearQuestion: true, resetCode: true });
    window.history.pushState({}, '', rolePaths[nextRole]);
    setRole(nextRole);
    setTeacherAuthenticated(false);
    setTeacherSection('teacher-overview');
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (!Object.values(rolePaths).includes(window.location.pathname))
      window.history.replaceState({}, '', rolePaths[roleFromPath()]);
    const pop = () => {
      if (roleFromPath() !== currentContext.current.role) invalidatePractice({ clearQuestion: true, resetCode: true });
      setTeacherSection('teacher-overview');
      setRole(roleFromPath());
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; contextRevision.current += 1; };
  }, []);

  useEffect(() => {
    const identity = `${classId}:${studentId}`;
    if (identity === previousIdentity.current) return;
    previousIdentity.current = identity;
    invalidatePractice({ clearQuestion: true, resetCode: true });
    setEvents([]);
  }, [classId, studentId]);

  useEffect(() => {
    let active = true;
    void getKiwi().then(client => {
      if (!active) return;
      setKiwi(client);
      setMode(client.mode);
      if (client.mode === 'live') setClassId(client.context?.classId || 'local-r-class');
    }).catch(() => { if (active) setMode('sim'); });
    void api.health().then(() => { if (active) setApiOnline(true); }).catch(() => { if (active) setApiOnline(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setCourse(null);
    void api.course(classId).then(value => {
      if (!active || currentContext.current.classId !== classId) return;
      invalidatePractice({ clearQuestion: true, resetCode: true });
      setCourse(value);
      setUnitId(value.currentUnitId);
      setQuestion(localQuestion(value.currentUnitId, type, difficulty));
    }).catch(() => { if (active) setSyncError('无法连接本地 API。请启动 python3 server/app.py。'); });
    return () => { active = false; };
  }, [classId]);

  useEffect(() => {
    if (!apiOnline || role !== 'student') return;
    let active = true;
    const ownsCurrentEvents = () => active && currentContext.current.classId === classId &&
      currentContext.current.studentId === studentId && currentContext.current.role === 'student';
    void api.studentEvents(classId, studentId).then(value => {
      if (!ownsCurrentEvents()) return;
      setEvents(previous => [...new Map([...value, ...previous].map(event => [event.id, event])).values()]
        .sort((left, right) => right.id - left.id).slice(0, 120));
    }).catch(() => { if (ownsCurrentEvents()) setEvents([]); });
    return () => { active = false; };
  }, [apiOnline, classId, studentId, role]);

  useEffect(() => {
    setFocusNote(localStorage.getItem(`kiwi-lab-focus-${studentId}`) || '');
  }, [studentId]);

  useEffect(() => {
    if (!kiwi || !course || role !== 'student') return;
    kiwi.updateContext(`R 学习单元：${currentUnit?.title || ''}。难度：${difficulty}/5。${contextSummary} 学生自述：${focusNote.slice(0, 400)}。当前题目：${question?.title || '未选'}。`);
  }, [kiwi, course, currentUnit?.title, difficulty, contextSummary, focusNote, question?.title, role]);

  const track = useCallback(async (eventType: string, payload: Record<string, unknown>, questionId?: string) => {
    const ownsCurrentEvents = () => mounted.current && currentContext.current.classId === classId &&
      currentContext.current.studentId === studentId && currentContext.current.role === 'student';
    try {
      const saved = await api.event({ classId, studentId, studentName, sessionId, type: eventType, questionId, payload });
      if (!ownsCurrentEvents()) return;
      setEvents(previous => [{ id: saved.id, classId, studentId, studentName, sessionId,
        type: eventType, questionId, payload, createdAt: new Date().toISOString() }, ...previous].slice(0, 120));
      setSyncError('');
    } catch (error) {
      if (!ownsCurrentEvents()) return;
      setSyncError(`记录未保存：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [classId, studentId, studentName]);

  useEffect(() => {
    if (!apiOnline || !code || code === lastSavedCode.current || role !== 'student' || view !== 'student') return;
    const timer = setTimeout(() => {
      lastSavedCode.current = code;
      void track('code_edited', { code, length: code.length }, question?.id);
    }, 1800);
    return () => clearTimeout(timer);
  }, [code, apiOnline, view, track, question?.id, role]);

  useEffect(() => {
    if (!apiOnline || role !== 'student') return;
    let lastActivity = Date.now();
    const active = () => { lastActivity = Date.now(); };
    window.addEventListener('pointerdown', active);
    window.addEventListener('keydown', active);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - lastActivity < 60_000)
        void track('study_heartbeat', { seconds: 30, view });
    }, 30_000);
    return () => { window.clearInterval(timer); window.removeEventListener('pointerdown', active); window.removeEventListener('keydown', active); };
  }, [apiOnline, view, track, role]);

  useEffect(() => {
    if (!question || role !== 'student' || view !== 'student' || activeTab !== 'question' || !revealNewQuestion.current) return;
    revealNewQuestion.current = false;
    questionPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [question, role, view, activeTab]);

  const changeStudent = (value: string) => {
    if (value === studentChoice) return;
    invalidatePractice({ clearQuestion: true, resetCode: true });
    setStudentChoice(value); localStorage.setItem('kiwi-lab-student', value);
    setEvents([]); setFocusNote('');
  };

  const chooseUnit = (id: string) => {
    if (id === unitId) return;
    invalidatePractice({ clearQuestion: true });
    setUnitId(id);
    void track('topic_changed', { unitId: id });
  };

  const chooseType = (value: QuestionType) => {
    if (value === type) return;
    invalidatePractice({ clearQuestion: true });
    setType(value);
  };

  const chooseDifficulty = (value: Difficulty) => {
    if (value === difficulty) return;
    invalidatePractice({ clearQuestion: true });
    setDifficulty(value);
    void track('difficulty_changed', { difficulty: value });
  };

  const saveFocus = () => {
    localStorage.setItem(`kiwi-lab-focus-${studentId}`, focusNote.slice(0, 400));
    void track('profile_updated', { focusNote: focusNote.slice(0, 400) });
  };

  const newQuestion = async () => {
    if (!course || generating || runInFlight.current || role !== 'student') return;
    const stamp = beginRequest('generation');
    setGenerating(true); setGenerationError('');
    try {
      const next = await generateQuestion({ course, unitId, type, difficulty, events, kiwi, focusNote });
      if (!requestIsCurrent('generation', stamp)) return;
      if (question && !feedback?.correct) void track('question_skipped', { title: question.title, answered: Boolean(feedback) }, question.id);
      invalidatePractice({ cancelGeneration: false });
      revealNewQuestion.current = true;
      setFeedback(null); setHint(''); setAnswer(''); setRunResult(null); setActiveTab('question');
      setQuestion(next);
      if (next.type === 'complete' && next.starterCode) { setCode(next.starterCode); lastSavedCode.current = next.starterCode; }
      else if (next.type === 'predict' && next.code) { setCode(next.code); lastSavedCode.current = next.code; }
      void track('question_generated', { title: next.title, questionType: next.type, difficulty,
        unitId, source: next.source, prompt: next.prompt, code: next.code || '', choices: next.choices || [] }, next.id);
    } catch (error) {
      if (requestIsCurrent('generation', stamp))
        setGenerationError(`题目生成失败，请重试：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (mounted.current && requestIds.current.generation === stamp.id) setGenerating(false);
    }
  };

  const showGeneratorSettings = () => {
    generatorPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    unitSelectRef.current?.focus({ preventScroll: true });
  };

  const submit = () => {
    if (!question || generating || running) return;
    if (question.type === 'complete' && (!runResult || !runResult.ok || runResult.code !== code || !requestIsCurrent('run', runResult.stamp))) {
      setFeedback({ correct: false, text: '请成功运行当前代码后再检查答案；修改代码后需要重新运行。' }); return;
    }
    if (question.type !== 'complete' && !answer.trim()) return;
    const correct = checkAnswer(question, question.type === 'complete' ? code : answer, runResult?.output);
    setFeedback({ correct, text: correct ? '答对了！你已经掌握这个知识点。' : '还差一步。看看提示或运行代码，再试一次。' });
    void track('answer_submitted', { title: question.title, questionType: question.type,
      answer: question.type === 'complete' ? code : answer, correct,
      expected: question.answer, runOutput: runResult?.output || '' }, question.id);
  };

  const execute = async () => {
    if (runInFlight.current || generating || !code.trim() || role !== 'student') return;
    const stamp = beginRequest('run');
    const executedCode = code;
    const executedQuestion = question;
    runInFlight.current = true;
    setRunning(true); setRunResult(null); setFeedback(null); setActiveTab('editor');
    try {
      let result: RunResult;
      try { result = await runR(executedCode); }
      catch (error) { result = { ok: false, output: '', error: error instanceof Error ? error.message : String(error), durationMs: 0, plots: [] }; }
      if (requestIsCurrent('run', stamp) && currentContext.current.code === executedCode)
        setRunResult({ ...result, code: executedCode, stamp });
      else result.plots.forEach(plot => plot.close());
      void track('code_run', { code: executedCode, ok: result.ok, output: result.output, error: result.error || '',
        durationMs: result.durationMs, plotCount: result.plots.length, questionTitle: executedQuestion?.title || '' }, executedQuestion?.id);
    } finally {
      runInFlight.current = false;
      if (mounted.current && requestIds.current.run === stamp.id) setRunning(false);
    }
  };

  const requestHint = async () => {
    if (!question || hintLoading || generating || role !== 'student') return;
    const stamp = beginRequest('hint');
    setHintLoading(true);
    let result = question.type === 'complete' ? '先找出 TODO 处需要赋值的变量，再用 print() 检查最后结果。' :
      question.type === 'predict' ? '按代码执行顺序追踪变量的值，留意 R 的索引从 1 开始。' :
      '找出题目中的关键操作，再对照 R 的语法逐步判断。';
    if (kiwi?.mode === 'live') {
      try {
        result = await kiwi.askAI(`请为这道 R 题给一个简短提示，不要直接给答案。题目：${question.prompt}。学习进度：${currentUnit?.goal || ''}。学生最近情况：${contextSummary}`);
      } catch { /* retain local hint */ }
    }
    if (!requestIsCurrent('hint', stamp)) return;
    setHint(result); setHintLoading(false);
    void track('hint_requested', { title: question.title, hint: result }, question.id);
  };

  const resetEditor = () => {
    replaceCode(question?.starterCode || question?.code || defaultCode);
  };

  const returnToQuestion = () => {
    setActiveTab('question');
    if (activeTab === 'question') questionPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else revealNewQuestion.current = true;
  };

  const updateCourse = (updated: Course) => {
    invalidatePractice({ clearQuestion: true, resetCode: true });
    setCourse(updated); setUnitId(updated.currentUnitId);
  };

  const openTeacherSection = (id: string) => {
    setTeacherSection(id);
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (id === 'teacher-overview') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (role === 'entry') return <RoleEntry courseTitle={course?.title || 'CSS · Computational Social Science'} canTeach={canTeach} onChoose={navigateRole} />;

  if (!course) return <div className="boot-screen"><span className="brand-mark">kiwi</span><LoaderCircle className="spin" size={22} /><p>正在加载{role === 'teacher' ? '教师' : '学生'}工作台…</p>{syncError && <small>{syncError}</small>}</div>;

  return <div className={`app-shell role-${role}`}>
    <aside className="sidebar">
      <KiwiBrand />
      <div className="sidebar-scroll">
        <div className="sidebar-section-title">{role === 'teacher' ? 'TEACHER WORKSPACE' : 'STUDENT WORKSPACE'}</div>
        {role === 'teacher' ? <>
          <button className={`nav-item ${teacherSection === 'teacher-overview' ? 'active' : ''}`} aria-current={teacherSection === 'teacher-overview' ? 'location' : undefined} title="教学概览" onClick={() => openTeacherSection('teacher-overview')}><GraduationCap size={18} /> 教学概览</button>
          <button className={`nav-item ${teacherSection === 'assignment-manager' ? 'active' : ''}`} aria-current={teacherSection === 'assignment-manager' ? 'location' : undefined} title="作业管理" disabled={!teacherAuthenticated} onClick={() => openTeacherSection('assignment-manager')}><BookOpen size={18} /> 作业管理</button>
          <button className={`nav-item ${teacherSection === 'student-data-hub' ? 'active' : ''}`} aria-current={teacherSection === 'student-data-hub' ? 'location' : undefined} title="学生 Data Hub" disabled={!teacherAuthenticated} onClick={() => openTeacherSection('student-data-hub')}><Users size={18} /> 学生 Data Hub</button>
          <button className={`nav-item ${teacherSection === 'homework-grading' ? 'active' : ''}`} aria-current={teacherSection === 'homework-grading' ? 'location' : undefined} title="作业批改" disabled={!teacherAuthenticated} onClick={() => openTeacherSection('homework-grading')}><CheckCircle2 size={18} /> 作业批改</button>
          <button className={`nav-item ${teacherSection === 'course-plan' ? 'active' : ''}`} aria-current={teacherSection === 'course-plan' ? 'location' : undefined} title="课程设置" disabled={!teacherAuthenticated} onClick={() => openTeacherSection('course-plan')}><Settings2 size={18} /> 课程设置</button>
          <button className={`nav-item ${teacherSection === 'activity-history' ? 'active' : ''}`} aria-current={teacherSection === 'activity-history' ? 'location' : undefined} title="学习时间线" disabled={!teacherAuthenticated} onClick={() => openTeacherSection('activity-history')}><Clock3 size={18} /> 学习时间线</button>
        </> : <>
        <button className={`nav-item ${view === 'student' ? 'active' : ''}`} title="自由练习" onClick={() => changeView('student')}><Command size={18} /> 自由练习</button>
        <button className={`nav-item ${view === 'work' ? 'active' : ''}`} title="练习与作业" onClick={() => changeView('work')}><BookOpen size={18} /> 练习与作业</button>
        <div className="sidebar-divider" />
        <div className="sidebar-section-title row-between">课程进度 <span>{Math.max(progressIndex + 1, 1)}/{course.units.length}</span></div>
        <div className="course-list">{course.units.map((unit, index) => <button key={unit.id} className={`course-item ${unitId === unit.id ? 'selected' : ''}`} onClick={() => { chooseUnit(unit.id); changeView('student'); }}>
          <span className={`course-step ${unit.status}`}>{unit.status === 'completed' ? <Check size={13} /> : String(index + 1).padStart(2, '0')}</span>
          <span className="course-name">{unit.title.replace(/^\d+\s*·\s*/, '')}<small>{unit.status === 'current' ? '当前单元' : unit.status === 'completed' ? '已完成' : '即将开始'}</small></span>
        </button>)}</div></>}
      </div>
      <div className="sidebar-bottom">{role === 'student' && <><div className="progress-label"><span>课程完成度</span><strong>{Math.round((Math.max(progressIndex, 0) + 1) / course.units.length * 100)}%</strong></div><div className="progress-track"><span style={{ width: `${(Math.max(progressIndex, 0) + 1) / course.units.length * 100}%` }} /></div></>}
        <div className="sidebar-profile"><span className="avatar">{accountName.slice(0, 1).toUpperCase()}</span><span><strong>{accountName}</strong><small>{role === 'teacher' ? '教师端 · 课程管理' : mode === 'live' ? 'Kiwi 学生账户' : '学生端 · 本地演示'}</small></span><span className="profile-online" /></div>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb">{role === 'teacher' ? '教师端' : '学生端'} <span>/</span> {course.title} <span>/</span> <strong>{role === 'teacher' ? '教师工作台' : view === 'student' ? '自由练习' : '课程练习与作业'}</strong></div><div className="topbar-right"><button className="text-button role-switch" onClick={() => navigateRole('entry')}>切换入口</button><span className={`connection-pill ${mode === 'live' ? 'live' : ''}`}><span className="connection-dot" />{mode === 'live' ? 'KIWI LIVE' : mode === 'sim' ? 'LOCAL DEMO' : 'CONNECTING'}</span><span className="top-avatar" aria-label={accountName}>{accountName.slice(0, 1).toUpperCase()}</span></div></header>
      {role === 'teacher' ? canTeach ? <TeacherDashboard classId={classId} course={course} onCourse={updateCourse} onBack={() => navigateRole('entry')} onAuthenticationChange={setTeacherAuthenticated} /> : <div className="teacher-login-screen"><h1>当前账户没有教师权限</h1><button className="primary-button" onClick={() => navigateRole('student')}>返回学生端</button></div> :
      view === 'work' ? <><div className="work-demo-identity">{mode !== 'live' && <label>本地模拟学生 <select value={studentChoice} onChange={e => changeStudent(e.target.value)}><option value="ada">Ada Chen</option><option value="bo">Bo Lin</option></select></label>}</div><StudentWork key={`${classId}:${studentId}`} classId={classId} course={course} studentId={studentId} studentName={studentName} kiwi={kiwi} events={events} track={track} /></> :
      <div className="student-content">
        <section className="page-intro"><div><p className="eyebrow">YOUR LEARNING SPACE</p><h1>边练边学 R<span className="accent-dot">.</span></h1><p className="muted">跟着课程进度练习，在右侧运行代码并一步步调试。</p></div><div className="session-meta"><Clock3 size={16} /> 本次会话已记录</div></section>
        {mode !== 'live' && <div className="demo-strip"><span><Sparkles size={16} /> 本地演示模式：题目由可运行的本地模板生成；嵌入 Kiwi 后会优先调用 AI。</span><label>模拟学生 <select value={studentChoice} onChange={e => changeStudent(e.target.value)}><option value="ada">Ada Chen</option><option value="bo">Bo Lin</option></select><ChevronDown size={14} /></label></div>}
        {syncError && <div className="sync-warning">{syncError}</div>}

        <div className="workspace-grid">
          <div className="left-column">
            <section className="panel context-panel"><div className="panel-heading"><div><p className="eyebrow">CURRENT FOCUS</p><h2>{currentUnit?.title || '选择单元'}</h2></div><span className="unit-badge">单元 {course.units.findIndex(unit => unit.id === unitId) + 1}</span></div>
              <p className="context-goal">{currentUnit?.goal}</p><div className="context-foot"><span className="context-icon"><BookOpen size={15} /></span><span>{contextSummary}</span></div><div className="focus-entry"><label htmlFor="focus-note">我目前想加强…</label><textarea id="focus-note" rows={2} maxLength={400} value={focusNote} onChange={e => setFocusNote(e.target.value)} placeholder="例如：我总分不清向量索引从几开始" /><button className="text-button" onClick={saveFocus}>保存学习情况 <ArrowRight size={14} /></button></div></section>
            <section className="panel generator-panel" ref={generatorPanelRef} id="practice-settings"><div className="panel-heading"><div><p className="eyebrow">PRACTICE BUILDER</p><h2>生成练习</h2></div><Settings2 size={18} /></div>
              <p className="form-intro">根据课程单元、题型和你的练习记录选择下一题。</p>
              <label className="field-label" htmlFor="unit-select">课程单元</label>
              <div className="select-wrap"><select id="unit-select" ref={unitSelectRef} value={unitId} onChange={e => chooseUnit(e.target.value)}>{course.units.map(unit => <option key={unit.id} value={unit.id}>{unit.title}</option>)}</select><ChevronDown size={16} /></div>
              <p className="field-label">题目类型</p><div className="type-grid">{types.map(item => <button key={item.id} className={`type-button ${type === item.id ? 'selected' : ''}`} onClick={() => chooseType(item.id)}>{item.short}</button>)}</div>
              <div className="difficulty-heading"><span className="field-label">难度</span><strong>{difficulty} / 5 <span>{['', '入门', '基础', '进阶', '挑战', '深入'][difficulty]}</span></strong></div>
              <div className="difficulty-track">{([1, 2, 3, 4, 5] as Difficulty[]).map(level => <button key={level} aria-label={`难度 ${level}`} className={level <= difficulty ? 'active' : ''} onClick={() => chooseDifficulty(level)} />)}</div>
              <button className="primary-button generate-button" disabled={generating || running} onClick={() => void newQuestion()}>{generating ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />} {generating ? '生成中…' : '生成下一题'} <ArrowRight size={16} /></button>
            </section>
            <section className="panel tips-panel"><span className="tips-illustration"><Lightbulb size={20} /></span><div><strong>调试小贴士</strong><p>遇到报错时，先看第一行提示，再用 print() 或 str() 检查变量。</p></div></section>
          </div>

          <div className="right-column">
            <div className="mobile-tabs"><button className={activeTab === 'question' ? 'active' : ''} onClick={() => setActiveTab('question')}>练习题</button><button className={activeTab === 'editor' ? 'active' : ''} onClick={() => setActiveTab('editor')}>R 工作台</button></div>
            <section className={`panel question-panel ${activeTab === 'editor' ? 'mobile-hidden' : ''}`} ref={questionPanelRef} id="current-practice" aria-busy={generating}><div className="question-topline"><div className="question-meta"><span className="question-number">PRACTICE / {question?.id.slice(-5).toUpperCase() || 'NEW'}</span><span className="separator-dot">·</span><span>{types.find(item => item.id === question?.type)?.label || '选择题'}</span></div><span className="question-source"><Sparkles size={13} /> {question?.source === 'kiwi-ai' ? 'KIWI AI' : '本地题库'}</span></div>
              {generationError && <p className="error-text" role="alert">{generationError}</p>}
              {question ? <><h2>{question.title}</h2><p className="question-prompt">{question.prompt}</p>{question.code && <pre className="question-code"><span className="code-language">R</span><code>{question.code}</code></pre>}
                {question.type === 'choice' ? <div className="choices">{(question.choices || []).map((choice, index) => <button key={`${choice}-${index}`} className={`choice ${answer === choice ? 'selected' : ''}`} disabled={generating} onClick={() => { setAnswer(choice); setFeedback(null); }}><span>{String.fromCharCode(65 + index)}</span>{choice}</button>)}</div> :
                question.type === 'complete' ? <div className="complete-prompt"><Code2 size={17} /><span>在 R 工作台补全代码并运行，然后检查答案。</span><button className="text-button" onClick={() => setActiveTab('editor')}>打开 R 工作台 <ArrowRight size={14} /></button></div> :
                <input className="answer-input" aria-label="你的答案" disabled={generating} value={answer} onChange={e => { setAnswer(e.target.value); setFeedback(null); }} onKeyDown={e => { if (e.key === 'Enter') submit(); }} placeholder={question.type === 'predict' ? '输入你预测的输出…' : '输入填空答案…'} />}
                {hint && <div className="hint-box"><Lightbulb size={16} /><span>{hint}</span></div>}
                {feedback && <div className={`feedback ${feedback.correct ? 'correct' : 'incorrect'}`}>{feedback.correct ? <CheckCircle2 size={18} /> : <XCircle size={18} />}<span>{feedback.text}{feedback.correct && <small>{question.explanation}</small>}</span></div>}
                <div className="question-actions">
                  {feedback?.correct ? <button className="primary-button" disabled={generating || running} onClick={() => void newQuestion()}>{generating ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} {generating ? '生成中…' : '生成下一题'} <ArrowRight size={16} /></button> : <><button className="primary-button" disabled={generating || running || (question.type !== 'complete' && !answer.trim())} onClick={submit}>{feedback ? '再次检查' : '检查答案'} <ArrowRight size={16} /></button><button className="outline-button next-question-button" disabled={generating || running} onClick={() => void newQuestion()}>{generating ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} {generating ? '生成中…' : '生成下一题'}</button></>}
                  <button className="text-button" disabled={hintLoading || generating} onClick={() => void requestHint()}><CircleHelp size={16} /> {hintLoading ? '思考中…' : '给我提示'}</button>
                  <button className="text-button generator-return" onClick={showGeneratorSettings}><ArrowLeft size={16} /> 返回生成设置</button>
                </div>
              </> : <div className="question-empty"><Sparkles size={28} /><h2>准备好下一题了吗？</h2><p>选择题型与难度，然后开始下一道练习。</p><button className="primary-button" disabled={generating || running} onClick={() => void newQuestion()}>{generating ? '生成中…' : '生成题目'} <ArrowRight size={16} /></button><button className="text-button" onClick={showGeneratorSettings}><Settings2 size={16} /> 返回生成设置</button></div>}</section>

            <section className={`panel editor-panel ${activeTab === 'question' ? 'mobile-hidden' : ''}`}><div className="editor-header"><div><p className="eyebrow">R PLAYGROUND</p><h2><Terminal size={20} /> 代码工作台</h2></div><div className="runtime-status"><span /> browser webR</div></div>
              <div className="editor-toolbar"><span><Code2 size={15} /> main.R</span><button className="text-button" disabled={generating} onClick={resetEditor}><RotateCcw size={14} /> 重置代码</button></div>
              <div className="code-editor-wrap"><div className="line-numbers" aria-hidden="true">{code.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea spellCheck={false} aria-label="R 代码编辑器" disabled={generating} value={code} onChange={e => replaceCode(e.target.value)} /></div>
              <div className="editor-runbar"><span><span className="status-circle" /> R 环境在浏览器中运行</span><button className="run-button" disabled={running || generating || !code.trim()} onClick={() => void execute()}>{running ? <LoaderCircle size={15} className="spin" /> : <Play size={15} fill="currentColor" />} {running ? '运行中…' : '运行代码'}</button></div>
              <div className="output-area"><div className="output-heading"><Terminal size={14} /> 控制台输出 {runResult && <span>{runResult.durationMs} ms</span>}</div>
                {runResult ? <><pre className={runResult.ok ? '' : 'output-error'}>{runResult.output || runResult.error || '代码运行完成，没有文本输出。'}</pre>{!runResult.ok && <div className="debug-tip"><Lightbulb size={15} /> {debugHint(runResult.error || runResult.output)}</div>}{runResult.plots.map((plot, index) => <Plot key={index} image={plot} />)}</> : <p className="output-placeholder">点击「运行代码」查看输出。第一次启动 R 环境可能需要几秒钟。</p>}
              </div>
              <div className="editor-question-return"><button className="text-button" onClick={returnToQuestion}><ArrowLeft size={16} /> 返回练习题并检查答案</button></div>
            </section>
            {recentRuns.length > 0 && <section className="recent-runs"><div className="recent-heading"><h3>最近运行</h3><span>调试轨迹</span></div>{recentRuns.map(event => <button key={event.id} disabled={generating} onClick={() => { if (typeof event.payload.code === 'string') replaceCode(event.payload.code); setActiveTab('editor'); }}><span className={`run-indicator ${event.payload.ok ? 'ok' : 'error'}`} /> <strong>{event.payload.ok ? '运行成功' : '运行报错'}</strong><small>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small><ArrowRight size={14} /></button>)}</section>}
          </div>
        </div>
      </div>}
    </main>
  </div>;
}

export default App;
