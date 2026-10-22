import { getRuntime, runR } from './LabRRuntime';

const initWebR = getRuntime;

/** Use webR's captured streams and conditions; errors must remain errors. */
async function runRCode(code: string, fileName = '', fileContent = '', fileBuffer = new ArrayBuffer(0),
  newFileNames: string[] = [], newFileBuffers: ArrayBuffer[] = []) {
  const webr = await getRuntime();
  const workingDirectory = await webr.evalRString('getwd()');
  const safeName = (name: string) => name.split(/[\\/]/).pop() || 'input.txt';
  for (let i = 0; i < newFileNames.length; i++) {
    if (newFileBuffers[i]) await webr.FS.writeFile(`${workingDirectory}/${safeName(newFileNames[i])}`, new Uint8Array(newFileBuffers[i]));
  }
  if (fileName) await webr.FS.writeFile(`${workingDirectory}/${safeName(fileName)}`, fileBuffer.byteLength ? new Uint8Array(fileBuffer) : new TextEncoder().encode(fileContent));
  const result = await runR(code);
  const images: string[] = [];
  for (const bitmap of result.plots) {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    images.push(canvas.toDataURL('image/png'));
    bitmap.close();
  }
  const modifiedFileBuffers = await Promise.all(newFileNames.map(async (name, i) => {
    try { const data = await webr.FS.readFile(`${workingDirectory}/${safeName(name)}`); return Uint8Array.from(data).buffer; }
    catch { return newFileBuffers[i]; }
  }));
  return { results: result.output || (result.ok ? 'No console output.' : ''),
    stdoutLines: [result.output || (result.ok ? 'No console output.' : '')],
    error: result.error || '', stderr: result.error || '', images, variables: [],
    modifiedFileContent: fileContent, modifiedFileBuffer: fileBuffer, modifiedFileNames: newFileNames, modifiedFileBuffers };
}

export { runRCode, initWebR };
