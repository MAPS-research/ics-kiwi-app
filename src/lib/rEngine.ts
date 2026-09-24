import { WebR } from 'webr';

export interface RunResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  plots: ImageBitmap[];
}

let runtime: WebR | null = null;
let starting: Promise<WebR> | null = null;

export async function getRuntime(): Promise<WebR> {
  if (runtime) return runtime;
  if (!starting) {
    starting = (async () => {
      const webr = new WebR({ baseUrl: `${location.origin}/webr/`, interactive: false });
      try {
        await webr.init();
        runtime = webr;
        return webr;
      } catch (error) {
        webr.close();
        throw error;
      } finally {
        starting = null;
      }
    })();
  }
  return starting;
}

async function conditionText(value: unknown): Promise<string> {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'toJs' in value && typeof value.toJs === 'function') {
    try {
      const result = await value.toJs() as unknown;
      if (typeof result === 'string') return result;
      if (result && typeof result === 'object' && 'message' in result) return String(result.message);
      return JSON.stringify(result);
    } catch { /* use generic string */ }
  }
  return String(value);
}

export async function runR(code: string, timeoutMs = 12_000): Promise<RunResult> {
  const started = performance.now();
  if (!code.trim()) return { ok: false, output: '', error: '请输入 R 代码。', durationMs: 0, plots: [] };
  let webr: WebR;
  try {
    webr = await getRuntime();
  } catch (error) {
    return { ok: false, output: '', error: `R 运行环境启动失败：${String(error)}`, durationMs: Math.round(performance.now() - started), plots: [] };
  }
  let timer: number | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      webr.close();
      if (runtime === webr) runtime = null;
      reject(new Error(`运行超过 ${timeoutMs / 1000} 秒，R 环境已重置。请检查循环或计算量。`));
    }, timeoutMs);
  });
  try {
    const execution = (async () => {
      const shelter = await new webr.Shelter();
      try {
        const result = await shelter.captureR(code, { captureGraphics: false });
        const lines: string[] = [];
        let failure = '';
        for (const entry of result.output) {
          const message = await conditionText(entry.data);
          if (entry.type === 'error') failure = message;
          lines.push(message);
        }
        return { ok: !failure, output: lines.join('\n').trim(), error: failure || undefined,
          plots: result.images, durationMs: Math.round(performance.now() - started) };
      } finally {
        await shelter.purge().catch(() => {});
      }
    })();
    return await Promise.race([execution, timedOut]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: '', error: message || 'R 执行失败，请检查代码后重试。',
      durationMs: Math.round(performance.now() - started), plots: [] };
  } finally {
    clearTimeout(timer);
  }
}

export function debugHint(error: string): string {
  const text = error.toLowerCase();
  if (text.includes('object') && text.includes('not found')) return '检查变量是否先定义，以及拼写和大小写是否一致。';
  if (text.includes('unexpected')) return '检查报错附近的括号、逗号和引号是否成对。';
  if (text.includes('subscript out of bounds')) return '检查索引是否超过向量或数据框的长度。R 的索引从 1 开始。';
  if (text.includes('non-numeric')) return '检查参与运算的值是否为数字；可用 str() 查看类型。';
  return '从报错第一行定位问题，再用 print() 或 str() 查看中间变量。修改后重新运行。';
}
