import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import type { Assignment, Course, HubData, Submission, WorkQuestion } from './types';

const newQuestion = (): WorkQuestion => ({ id: `q-${crypto.randomUUID()}`, type: 'text', prompt: '', points: 10,
  choices: [], starterCode: '', answer: '', explanation: '' });
const blank = (course: Course): { kind: 'practice' | 'homework'; title: string; unitId: string;
  instructions: string; dueAt: string | null; questions: WorkQuestion[] } => ({ kind: 'homework', title: '', unitId: course.currentUnitId,
  instructions: '', dueAt: null as string | null, questions: [newQuestion()] });
type Draft = ReturnType<typeof blank> & { id?: string; status?: 'draft' | 'published'; attachmentName?: string | null };

function exportHub(hub: HubData) {
  const head = ['学生 ID', '学生', ...hub.assignments.flatMap(a => [`${a.title} 得分`, `${a.title} 提交次数`]),
    '互动次数', '学习分钟', '自由练习次数', 'R 运行次数', 'Kiwi 提问次数'];
  const rows = hub.students.map(s => [s.studentId, s.studentName,
    ...hub.assignments.flatMap(a => [s.scoreByAssignment[a.id] ?? '', s.attemptsByAssignment[a.id] ?? 0]),
    s.interactions, Math.round(s.learningSeconds / 60), s.freePracticeCount, s.codeRuns, s.aiQuestions]);
  const csv = [head, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'css-kiwi-data-hub.csv'; link.click();
  URL.revokeObjectURL(url);
}

export function TeacherWork({ classId, course, teacherKey, onSelectStudent, refreshVersion }: {
  classId: string; course: Course; teacherKey: string; onSelectStudent: (id: string) => void; refreshVersion: number;
}) {
  const [works, setWorks] = useState<Assignment[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [hub, setHub] = useState<HubData>({ assignments: [], students: [] });
  const [draft, setDraft] = useState<Draft>(blank(course));
  const [attachment, setAttachment] = useState<{ name: string; type: string; data: string } | null>(null);
  const [gradeValues, setGradeValues] = useState<Record<string, { grade: string; feedback: string }>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageArea, setMessageArea] = useState<'manager' | 'editor' | 'grading' | 'hub'>('editor');
  const [gradedId, setGradedId] = useState('');
  const [rosterText, setRosterText] = useState('');

  const refresh = useCallback(async () => {
    const [work, subs, data] = await Promise.all([
      api.work(classId, teacherKey), api.submissions(classId, undefined, teacherKey), api.hub(classId, teacherKey),
    ]);
    setWorks(work); setSubmissions(subs); setHub(data);
  }, [classId, teacherKey]);
  useEffect(() => { void refresh().catch(e => { setMessageArea('manager'); setMessage(e.message); }); }, [refresh, refreshVersion]);

  const edit = (work: Assignment) => {
    setDraft({ id: work.id, kind: work.kind, title: work.title, unitId: work.unitId,
      instructions: work.instructions, dueAt: work.dueAt, status: work.status,
      attachmentName: work.attachmentName, questions: structuredClone(work.questions) });
    setAttachment(null); setMessage(''); setMessageArea('editor');
    document.getElementById('work-editor')?.scrollIntoView({ behavior: 'smooth' });
  };
  const updateQuestion = (id: string, update: Partial<WorkQuestion>) =>
    setDraft(previous => ({ ...previous, questions: previous.questions.map(q => q.id === id ? { ...q, ...update } : q) }));
  const importFile = async (file?: File) => {
    if (!file) return;
    setMessageArea('editor');
    if (file.size > 3_000_000) { setMessage('附件最大 3 MB。'); return; }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file);
    });
    setAttachment({ name: file.name, type: file.type || 'application/octet-stream', data });
    if (/\.(qmd|md|txt)$/i.test(file.name)) {
      const text = await file.text();
      setDraft(previous => ({ ...previous, instructions: text.slice(0, 12000) }));
    }
    setMessage(`已载入 ${file.name}。请检查说明与题目，再保存草稿。`);
  };
  const save = async () => {
    setBusy(true); setMessage(''); setMessageArea('editor');
    try {
      const saved = await api.saveWork(classId, { ...draft, ...(attachment ? { attachment } : {}) }, teacherKey, draft.id);
      setDraft(previous => ({ ...previous, id: saved.id, attachmentName: saved.attachmentName, status: saved.status }));
      setAttachment(null); await refresh(); setMessage('草稿已保存。');
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const toggle = async (work: Assignment) => {
    setBusy(true); setMessage(''); setMessageArea('manager');
    try { await api.workStatus(classId, work.id, work.status === 'draft' ? 'published' : 'draft', teacherKey); await refresh();
      setMessage(work.status === 'draft' ? '已发布给学生。' : '已撤回为草稿。'); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const seed = async () => {
    setBusy(true); setMessage(''); setMessageArea('manager');
    try { const result = await api.seedSamples(classId, teacherKey); await refresh(); setMessage(`已添加 ${result.created} 份 CSS 示例草稿。`); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const grade = async (sub: Submission) => {
    const value = gradeValues[sub.id]; if (!value) return;
    setBusy(true); setMessage(''); setMessageArea('grading'); setGradedId(sub.id);
    try { await api.grade(classId, sub.id, Number(value.grade), value.feedback, teacherKey); await refresh(); setMessage('评分已保存。'); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const importRoster = async () => {
    const students = rosterText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      .filter(line => !/^student.?id[,\t]/i.test(line))
      .map(line => {
        const [studentId, ...name] = line.split(/[,\t]/);
        return { studentId: studentId.trim(), studentName: name.join(' ').trim() };
      });
    setBusy(true); setMessage(''); setMessageArea('hub');
    try { const result = await api.importRoster(classId, students, teacherKey); await refresh();
      setMessage(`已导入 ${result.count} 名学生，未活动学生也会显示在数据表中。`); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className="teacher-work">
    <section className="panel work-panel" id="assignment-manager">
      <div className="panel-heading"><div><p className="eyebrow">TEACHER AUTHORING</p><h2>练习与作业</h2></div><button className="outline-button" onClick={() => void seed()} disabled={busy}>载入 CSS 示例草稿</button></div>
      <p className="muted">示例根据四份 R 作业的技能范围改写。教师填写答案并检查后发布，学生端不会收到参考答案。</p>
      <div className="work-list">{works.map(work => <div className="work-list-row" key={work.id}>
        <div><strong>{work.title}</strong><small>{work.kind === 'homework' ? '作业' : '练习'} · {work.questions.length} 题 · {work.status === 'draft' ? '草稿' : '已发布'}</small></div>
        <button className="outline-button" onClick={() => edit(work)}>编辑</button>
        <button className="primary-button" disabled={busy} onClick={() => void toggle(work)}>{work.status === 'draft' ? '发布' : '撤回'}</button>
      </div>)}</div>
      <button className="text-button" onClick={() => { setDraft(blank(course)); setAttachment(null); setMessage(''); setMessageArea('editor'); document.getElementById('work-editor')?.scrollIntoView({ behavior: 'smooth' }); }}>＋ 新建练习或作业</button>
      {message && messageArea === 'manager' && <p className="work-message" role="status">{message}</p>}
    </section>

    <section className="panel work-panel" id="work-editor">
      <div className="panel-heading"><div><p className="eyebrow">EDITOR</p><h2>{draft.id ? '编辑题目' : '新建题目'}</h2></div><span className="small-pill">{draft.status === 'published' ? '已发布' : '草稿'}</span></div>
      <div className="work-form-grid"><label>类型<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}><option value="practice">课堂练习</option><option value="homework">作业 / Homework</option></select></label>
        <label>对应单元<select value={draft.unitId} onChange={e => setDraft({ ...draft, unitId: e.target.value })}>{course.units.map(u => <option key={u.id} value={u.id}>{u.title}</option>)}</select></label>
        <label>标题<input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="例如：作业 2 · 数据连接" /></label>
        <label>截止时间<input type="datetime-local" value={draft.dueAt?.slice(0, 16) || ''} onChange={e => setDraft({ ...draft, dueAt: e.target.value || null })} /></label></div>
      <label className="work-label">说明 / 上传的题面<textarea rows={5} value={draft.instructions} onChange={e => setDraft({ ...draft, instructions: e.target.value })} /></label>
      <label className="work-label">上传作业文件（qmd、md、txt、pdf、csv、R、rds、zip；小于 3 MB）<input type="file" accept=".qmd,.md,.txt,.pdf,.csv,.r,.rds,.zip" onChange={e => void importFile(e.target.files?.[0]).catch(err => setMessage(err.message))} /></label>
      {(attachment?.name || draft.attachmentName) && <small>附件：{attachment?.name || draft.attachmentName}</small>}
      <div className="work-question-list">{draft.questions.map((q, index) => <div className="work-question-edit" key={q.id}>
        <div className="row-between"><strong>题目 {index + 1}</strong><button className="text-button" disabled={draft.questions.length === 1} onClick={() => setDraft({ ...draft, questions: draft.questions.filter(item => item.id !== q.id) })}>删除</button></div>
        <div className="work-form-grid"><label>题型<select value={q.type} onChange={e => updateQuestion(q.id, { type: e.target.value as WorkQuestion['type'] })}><option value="text">文字解释</option><option value="choice">选择</option><option value="fill">填空</option><option value="predict">代码预测</option><option value="complete">代码补全</option></select></label>
          <label>分值<input type="number" min="1" max="100" value={q.points} onChange={e => updateQuestion(q.id, { points: Number(e.target.value) })} /></label></div>
        <label className="work-label">题干<textarea rows={2} value={q.prompt} onChange={e => updateQuestion(q.id, { prompt: e.target.value })} /></label>
        {q.type === 'choice' && <label className="work-label">选项（每行一个）<textarea rows={4} value={q.choices.join('\n')} onChange={e => updateQuestion(q.id, { choices: e.target.value.split('\n') })} /></label>}
        {(q.type === 'complete' || q.type === 'predict') && <label className="work-label">R 起始代码<textarea className="mono" rows={5} value={q.starterCode} onChange={e => updateQuestion(q.id, { starterCode: e.target.value })} /></label>}
        <label className="work-label">参考答案<textarea rows={2} value={q.answer || ''} onChange={e => updateQuestion(q.id, { answer: e.target.value })} /></label>
        <label className="work-label">解析 / 评分要点<textarea rows={2} value={q.explanation || ''} onChange={e => updateQuestion(q.id, { explanation: e.target.value })} /></label>
      </div>)}</div>
      <div className="work-actions"><button className="outline-button" onClick={() => setDraft({ ...draft, questions: [...draft.questions, newQuestion()] })}>＋ 添加题目</button><button className="primary-button" disabled={busy} onClick={() => void save()}>保存草稿</button></div>
      {message && messageArea === 'editor' && <p className="work-message" role="status">{message}</p>}
    </section>

    <section className="panel work-panel" id="student-data-hub">
      <div className="panel-heading"><div><p className="eyebrow">DATA HUB</p><h2>班级学习数据</h2></div><button className="outline-button" onClick={() => exportHub(hub)}>导出 CSV</button></div>
      <p className="muted">每行一名学生。得分采用该作业最后一次已批改提交；学习时间为页面可见时的累计活动时长。</p>
      <p className="hub-scroll-hint">左右滑动表格可查看全部作业和学习数据。</p>
      <details className="roster-import"><summary>导入学生名单（含未活动学生）</summary><p>每行填写 studentId,学生姓名；正式接入 Kiwi 时，studentId 应与 Kiwi 用户 ID 一致。</p>
        <textarea rows={3} value={rosterText} onChange={e => setRosterText(e.target.value)} placeholder={'student-001,张同学\nstudent-002,李同学'} />
        <div className="work-actions"><label className="outline-button">选择 CSV / TSV 文件<input type="file" accept=".csv,.tsv,.txt" onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(setRosterText); }} /></label>
          <button className="primary-button" disabled={busy || !rosterText.trim()} onClick={() => void importRoster()}>导入名单</button></div></details>
      {message && messageArea === 'hub' && <p className="work-message" role="status">{message}</p>}
      <div className="hub-scroll"><table className="hub-table"><thead><tr><th>学生</th>{hub.assignments.map(a => <th key={`${a.id}-score`}>{a.title}<br />得分</th>)}{hub.assignments.map(a => <th key={`${a.id}-attempts`}>{a.title}<br />尝试</th>)}<th>互动</th><th>学习分钟</th><th>自由练习</th><th>R 运行</th><th>Kiwi 提问</th></tr></thead>
        <tbody>{hub.students.map(s => <tr key={s.studentId}><td><button className="text-button" onClick={() => onSelectStudent(s.studentId)}>{s.studentName}</button></td>{hub.assignments.map(a => <td key={`${a.id}-score`}>{s.scoreByAssignment[a.id] ?? '—'}</td>)}{hub.assignments.map(a => <td key={`${a.id}-attempts`}>{s.attemptsByAssignment[a.id] ?? 0}</td>)}<td>{s.interactions}</td><td>{Math.round(s.learningSeconds / 60)}</td><td>{s.freePracticeCount}</td><td>{s.codeRuns}</td><td>{s.aiQuestions}</td></tr>)}</tbody></table></div>
      {hub.students.length === 0 && <p className="empty-state">还没有学生记录。</p>}
    </section>

    <section className="panel work-panel" id="homework-grading">
      <div className="panel-heading"><div><p className="eyebrow">GRADING</p><h2>作业提交与评分</h2></div><button className="outline-button" disabled={busy} onClick={() => void refresh().catch(e => { setMessageArea('grading'); setGradedId(''); setMessage(e.message); })}>刷新</button></div>
      {message && messageArea === 'grading' && !gradedId && <p className="work-message" role="status">{message}</p>}
      {submissions.filter(s => works.some(w => w.id === s.assignmentId)).map(sub => {
        const work = works.find(w => w.id === sub.assignmentId)!;
        const max = work.questions.reduce((sum, q) => sum + q.points, 0);
        const value = gradeValues[sub.id] || { grade: sub.grade?.toString() || '', feedback: sub.feedback || '' };
        return <div className="grading-card" key={sub.id}><div className="row-between"><strong>{sub.studentName} · {work.title}</strong><small>第 {sub.attempt} 次提交 · {new Date(sub.submittedAt).toLocaleString('zh-CN')}</small></div>
          {work.questions.map(q => <div className="grading-answer" key={q.id}><strong>{q.prompt}（{q.points} 分）</strong><pre>{sub.answers[q.id] || '未答'}</pre><small>参考：{q.answer || '教师自行判断'}</small></div>)}
          <div className="grade-controls"><label>得分 / {max}<input type="number" min="0" max={max} value={value.grade} onChange={e => setGradeValues({ ...gradeValues, [sub.id]: { ...value, grade: e.target.value } })} /></label>
            <label>评语<input value={value.feedback} onChange={e => setGradeValues({ ...gradeValues, [sub.id]: { ...value, feedback: e.target.value } })} /></label>
            <button className="primary-button" disabled={busy || value.grade === ''} onClick={() => void grade(sub)}>保存评分</button></div>
          {message && messageArea === 'grading' && gradedId === sub.id && <p className="work-message" role="status">{message}</p>}
        </div>;
      })}
      {submissions.length === 0 && <p className="empty-state">暂无学生提交。</p>}
    </section>
  </div>;
}
