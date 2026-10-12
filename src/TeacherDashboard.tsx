import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeft, BookOpen, ChevronDown, ChevronRight, Code2, KeyRound, Plus, RefreshCw, Save, Trash2, Users } from 'lucide-react';
import { api } from './lib/api';
import { TeacherWork } from './TeacherWork';
import type { Course, EventRecord, StudentSummary } from './types';

const eventLabels: Record<string, string> = {
  question_generated: '生成题目', question_viewed: '查看题目', answer_submitted: '提交答案',
  code_run: '运行 R 代码', code_edited: '编辑代码', hint_requested: '请求提示',
  question_skipped: '跳过题目', difficulty_changed: '调整难度', topic_changed: '切换单元',
  profile_updated: '更新学习情况',
  ai_question: '向 Kiwi 提问', similar_requested: '请求相似题', study_heartbeat: '学习时长',
  work_opened: '打开练习 / 作业', work_answer_saved: '保存作业答案', work_submitted: '提交作业',
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function TeacherDashboard({ classId, course, onCourse, onBack, onAuthenticationChange }: {
  classId: string; course: Course; onCourse: (course: Course) => void; onBack: () => void;
  onAuthenticationChange: (authenticated: boolean) => void;
}) {
  const [inputKey, setInputKey] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [studentFilter, setStudentFilter] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState<Course>(structuredClone(course));
  const [saved, setSaved] = useState(false);
  const [workRefreshVersion, setWorkRefreshVersion] = useState(0);

  useEffect(() => {
    onAuthenticationChange(Boolean(key));
  }, [key, onAuthenticationChange]);

  const refresh = useCallback(async (secret: string, studentId = '') => {
    const [summary, history] = await Promise.all([
      api.summary(classId, secret), api.teacherEvents(classId, secret, studentId || undefined),
    ]);
    setStudents(summary.students);
    setTotalEvents(summary.totalEvents);
    setEvents(history);
    setHasMore(history.length === 100);
  }, [classId]);

  useEffect(() => {
    if (!key) return;
    void refresh(key, studentFilter).catch(e => setError(e.message));
  }, [key, studentFilter, refresh]);

  const login = async () => {
    setBusy(true); setError('');
    try { await api.verifyTeacher(inputKey); setKey(inputKey); setInputKey(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    try {
      const updated = await api.saveCourse(classId, draft, key);
      setDraft(updated); onCourse(updated); setSaved(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const loadMore = async () => {
    const oldest = events.at(-1)?.id;
    if (!oldest) return;
    setBusy(true);
    try {
      const older = await api.teacherEvents(classId, key, studentFilter || undefined, oldest);
      setEvents(previous => [...previous, ...older]);
      setHasMore(older.length === 100);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const addUnit = () => setDraft(previous => ({ ...previous, units: [...previous.units,
    { id: `unit-${crypto.randomUUID()}`, title: '新单元', goal: '填写本单元的学习目标', status: 'upcoming' as const }] }));
  const removeUnit = (id: string) => setDraft(previous => {
    const units = previous.units.filter(unit => unit.id !== id);
    return { ...previous, units, currentUnitId: previous.currentUnitId === id ? units[0]?.id || '' : previous.currentUnitId };
  });

  const runs = useMemo(() => events.filter(event => event.type === 'code_run'), [events]);
  const failures = runs.filter(event => event.payload.ok === false).length;
  const answers = events.filter(event => event.type === 'answer_submitted');
  const correct = answers.filter(event => event.payload.correct === true).length;
  const totalRuns = students.reduce((count, student) => count + student.runs, 0);
  const totalAnswers = students.reduce((count, student) => count + student.answers, 0);

  if (!key) return <div className="teacher-login-screen">
    <button className="text-button back-button" onClick={onBack}><ArrowLeft size={16} /> 返回入口</button>
    <div className="login-card">
      <div className="login-icon"><KeyRound size={25} /></div>
      <p className="eyebrow">TEACHER ACCESS</p>
      <h1>教师工作台</h1>
      <p className="muted">查看学生运行代码、答题尝试与课程进度。请输入本地服务的教师密钥。</p>
      <label className="field-label" htmlFor="teacher-key">教师密钥</label>
      <input id="teacher-key" type="password" value={inputKey} onChange={e => setInputKey(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void login(); }} placeholder="输入 KIWI_TEACHER_KEY" autoComplete="off" />
      {error && <p className="error-text">{error}</p>}
      <button className="primary-button full" disabled={!inputKey || busy} onClick={() => void login()}>{busy ? '验证中…' : '进入工作台'}</button>
      <p className="login-footnote">本地演示默认密钥：kiwi-local-demo。共享或部署前请在 .env 中修改。</p>
    </div>
  </div>;

  return <div className="teacher-content" id="teacher-overview">
    <div className="page-intro teacher-intro">
      <div>
        <button className="text-button" onClick={onBack}><ArrowLeft size={16} /> 退出教师端</button>
        <p className="eyebrow">INSTRUCTOR OVERVIEW · {classId}</p>
        <h1>教学概览<span className="accent-dot">.</span></h1>
        <p className="muted">每次答题、代码运行与调试过程都会留在时间线中。</p>
      </div>
      <button className="outline-button" disabled={busy} onClick={() => {
        setError('');
        setWorkRefreshVersion(previous => previous + 1);
        void refresh(key, studentFilter).catch(e => setError(e.message));
      }}><RefreshCw size={16} /> 刷新数据</button>
    </div>
    {error && <p className="error-text" role="alert">{error}</p>}

    <div className="metrics-grid">
      <div className="metric-card"><span className="metric-icon peach"><Users size={20} /></span><span>活跃学生</span><strong>{students.length}</strong><small>当前课程</small></div>
      <div className="metric-card"><span className="metric-icon blue"><Code2 size={20} /></span><span>代码运行</span><strong>{totalRuns}</strong><small>当前列表 {failures} 次报错</small></div>
      <div className="metric-card"><span className="metric-icon green"><BookOpen size={20} /></span><span>答题尝试</span><strong>{totalAnswers}</strong><small>当前列表 {correct} 次答对</small></div>
      <div className="metric-card"><span className="metric-icon lavender"><Activity size={20} /></span><span>互动事件</span><strong>{totalEvents}</strong><small>含编辑、提示与切换</small></div>
    </div>

    <TeacherWork classId={classId} course={course} teacherKey={key} onSelectStudent={setStudentFilter} refreshVersion={workRefreshVersion} />

    <div className="teacher-grid">
      <section className="panel course-editor" id="course-plan">
        <div className="panel-heading"><div><p className="eyebrow">COURSE PLAN</p><h2>课程进度设置</h2></div><BookOpen size={18} /></div>
        <label className="field-label" htmlFor="course-title">课程名称</label>
        <input id="course-title" value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
        <label className="field-label" htmlFor="course-desc">课程说明</label>
        <textarea id="course-desc" rows={2} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} />
        <p className="field-label">课程单元与学习目标</p>
        <div className="unit-editor-list">
          {draft.units.map((unit, index) => <div className="unit-editor-row" key={unit.id}>
            <label className="radio-label"><input type="radio" name="current-unit" checked={draft.currentUnitId === unit.id}
              onChange={() => setDraft({ ...draft, currentUnitId: unit.id })} /> 当前进度</label><button className="remove-unit" aria-label={`删除 ${unit.title}`} disabled={draft.units.length === 1} onClick={() => removeUnit(unit.id)}><Trash2 size={14} /></button>
            <input aria-label={`单元 ${index + 1} 名称`} value={unit.title} onChange={e => setDraft({ ...draft, units: draft.units.map(u => u.id === unit.id ? { ...u, title: e.target.value } : u) })} />
            <input aria-label={`单元 ${index + 1} 学习目标`} value={unit.goal} onChange={e => setDraft({ ...draft, units: draft.units.map(u => u.id === unit.id ? { ...u, goal: e.target.value } : u) })} />
          </div>)}
        </div>
        <button className="text-button add-unit" disabled={draft.units.length >= 30} onClick={addUnit}><Plus size={15} /> 添加单元</button>
        <div className="save-row"><button className="primary-button" disabled={busy} onClick={() => void save()}><Save size={15} /> 保存设置</button>{saved && <span className="success-text">已保存，学生端刷新后生效</span>}</div>
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="panel student-panel">
        <div className="panel-heading"><div><p className="eyebrow">STUDENTS</p><h2>学生列表</h2></div><Users size={18} /></div>
        {students.length === 0 ? <div className="empty-state">暂无学生互动记录。先在学生端运行代码或提交答案。</div> :
          <div className="student-list">
            <button className={`student-row ${studentFilter === '' ? 'selected' : ''}`} onClick={() => setStudentFilter('')}>
              <span className="avatar all-avatar">全</span><span className="student-row-main"><strong>全部学生</strong><small>查看班级完整时间线</small></span><ChevronRight size={16} />
            </button>
            {students.map(student => <button key={student.student_id} className={`student-row ${studentFilter === student.student_id ? 'selected' : ''}`} onClick={() => setStudentFilter(student.student_id)}>
              <span className="avatar">{student.name.slice(0, 1).toUpperCase()}</span><span className="student-row-main"><strong>{student.name}</strong><small>{student.runs} 次运行 · {student.answers} 次答题</small></span><ChevronRight size={16} />
            </button>)}
          </div>}
      </section>
    </div>

    <section className="panel timeline-panel" id="activity-history">
      <div className="panel-heading"><div><p className="eyebrow">ACTIVITY LOG</p><h2>学习与调试时间线</h2></div><span className="small-pill">最近 {events.length} 条</span></div>
      {events.length === 0 ? <div className="empty-state">这里会显示学生的代码、运行结果、答题与提示记录。</div> :
        <div className="timeline-list">{events.map(event => <div className="event-row" key={event.id}>
          <button className="event-summary" onClick={() => setExpandedId(expandedId === event.id ? null : event.id)}>
            <span className={`event-dot ${event.type === 'code_run' && event.payload.ok === false ? 'failed' : ''}`} />
            <span className="event-main"><strong>{eventLabels[event.type] || event.type}</strong><span>{event.studentName} · {event.payload.title ? String(event.payload.title) : event.type === 'code_run' ? (event.payload.ok ? '运行成功' : '运行报错') : ''}</span></span>
            <time>{formatTime(event.createdAt)}</time>{expandedId === event.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {expandedId === event.id && <div className="event-detail"><pre>{JSON.stringify(event.payload, null, 2)}</pre><small>学生 ID: {event.studentId} · 会话: {event.sessionId}</small></div>}
        </div>)}</div>}
      {hasMore && <button className="outline-button load-more" disabled={busy} onClick={() => void loadMore()}>加载更早记录</button>}
    </section>
  </div>;
}
