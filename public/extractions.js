// The POST returns immediately; short polling avoids proxy timeouts while a job waits.
export async function pollExtraction(initial, { request, isCurrent = () => true, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let data = initial, errors = 0;
  while (true) {
    if (!isCurrent()) throw new Error('La sesión cambió. Volvé a entrar para consultar el envío.');
    if (data.job.state === 'completed') return data.result;
    if (data.job.state === 'failed') throw Object.assign(new Error(data.error || 'No se pudo analizar. Podés reintentar el envío.'), { status: data.status, code: data.code });
    await sleep(1000);
    try { data = await request(`/api/extractions/${encodeURIComponent(initial.job.id)}`); errors = 0; }
    catch (error) { if (error.status || ++errors >= 3) throw error; }
  }
}
