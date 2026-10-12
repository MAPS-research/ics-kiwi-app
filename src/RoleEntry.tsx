import { ArrowRight, BookOpen, GraduationCap } from 'lucide-react';

export type AppRole = 'student' | 'teacher' | 'entry';

export function KiwiBrand() {
  return <div className="brand" aria-label="Kiwi CSS Lab"><span className="kiwi-wordmark">kiwi</span><span className="brand-name"><b>CSS Lab</b></span></div>;
}

export function RoleEntry({ courseTitle, canTeach, onChoose }: {
  courseTitle: string; canTeach: boolean; onChoose: (role: AppRole) => void;
}) {
  return <main className="role-entry">
    <KiwiBrand />
    <section className="role-entry-content">
      <p className="eyebrow">KIWI · CSS LEARNING</p>
      <h1>选择工作台</h1>
      <p className="muted">{courseTitle} · 学生练习与教师管理使用独立入口。</p>
      <div className="role-entry-grid">
        <button className="panel role-entry-card" onClick={() => onChoose('student')}>
          <BookOpen size={26} /><strong>学生工作台</strong><span>完成练习与作业、运行 R 代码，向 Kiwi 提问并继续巩固。</span><span className="role-entry-link">进入学生端 <ArrowRight size={17} /></span>
        </button>
        {canTeach && <button className="panel role-entry-card" onClick={() => onChoose('teacher')}>
          <GraduationCap size={26} /><strong>教师工作台</strong><span>布置与批改作业，查看学生尝试、代码运行和学习数据。</span><span className="role-entry-link">进入教师端 <ArrowRight size={17} /></span>
        </button>}
      </div>
    </section>
  </main>;
}
