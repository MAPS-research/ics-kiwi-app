import { describe, expect, it } from 'vitest';
import { checkAnswer, generateQuestion, localQuestion, localSimilarQuestion, normalizeAnswer } from './questions';
import type { Course, Difficulty, KiwiClient, QuestionType } from '../types';

describe('local R exercises', () => {
  it('provides all four types for each built-in unit and difficulty', () => {
    for (const unit of ['basics', 'vectors', 'conditions', 'dataframes']) {
      for (const type of ['fill', 'choice', 'predict', 'complete'] as QuestionType[]) {
        for (const difficulty of [1, 3, 5] as Difficulty[]) {
          const question = localQuestion(unit, type, difficulty);
          expect(question.prompt).not.toBe('');
          expect(question.answer).not.toBe('');
          if (type === 'choice') expect(question.choices).toContain(question.answer);
          if (type === 'complete') expect(question.starterCode).toContain('TODO');
        }
      }
    }
  });

  it('accepts normal R console prefixes and rejects stale code output', () => {
    expect(normalizeAnswer('[1] "Even"')).toBe('even');
    const question = localQuestion('vectors', 'complete', 2);
    expect(checkAnswer(question, question.starterCode!, `[1] ${question.expectedOutput}`)).toBe(true);
    expect(checkAnswer(question, question.starterCode!, undefined)).toBe(false);
  });

  it('uses a valid Kiwi AI question and falls back when the response is malformed', async () => {
    const course: Course = { title: 'R', description: '', currentUnitId: 'vectors',
      units: [{ id: 'vectors', title: '向量', goal: '索引', status: 'current' }] };
    const kiwi = {
      mode: 'live',
      documentChunks: async () => ({ documents: [], nextCursor: null, hasMore: false }),
      askAI: async () => JSON.stringify({ title: 'AI 向量题', prompt: '取第一个元素', answer: 'x[1]', explanation: 'R 从 1 开始。' }),
    } as unknown as KiwiClient;
    const input = { course, unitId: 'vectors', type: 'fill' as const, difficulty: 2 as const, events: [], kiwi };
    const generated = await generateQuestion(input);
    expect(generated.source).toBe('kiwi-ai');
    expect(generated.title).toBe('AI 向量题');
    kiwi.askAI = async () => 'not JSON';
    const fallback = await generateQuestion(input);
    expect(fallback.source).toBe('local');
  });

  it('uses the learner note to choose a relevant local review exercise', async () => {
    const course: Course = { title: 'R', description: '', currentUnitId: 'vectors',
      units: [{ id: 'vectors', title: '向量', goal: '索引', status: 'current' }] };
    const question = await generateQuestion({ course, unitId: 'vectors', type: 'choice', difficulty: 2,
      events: [], kiwi: null, focusNote: '我总弄错向量索引' });
    expect(question.title).toBe('索引专项练习');
    expect(question.choices).toContain(question.answer);
  });

  it('makes offline similar questions from the teacher question topic', () => {
    const question = { id: 'q1', type: 'choice' as const, prompt: 'seq() 的步长由什么决定？', points: 5,
      choices: [], starterCode: '' };
    const similar = localSimilarQuestion(question, 'r-basics', 2);
    expect(similar.prompt).toContain('生成');
    expect(similar.choices).toContain(similar.answer);
    const network = localSimilarQuestion({ ...question, prompt: '计算有向网络中 B 的入度' }, 'network-analysis', 2);
    expect(network.prompt).toContain('入度');
    expect(network.code).toContain('to == "B"');
  });
});
