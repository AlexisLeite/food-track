export async function readApiResponse(response) {
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid API response');
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const timeout = [408, 504, 524].includes(response.status);
    const unavailable = [502, 503, 520, 521, 522, 523, 525, 526, 530].includes(response.status);
    const message = timeout ? 'El servidor tardó demasiado en responder. Volvé a intentarlo.'
      : unavailable ? 'El servidor no está disponible en este momento. Volvé a intentarlo en unos segundos.'
        : 'No se pudo leer la respuesta del servidor. Volvé a intentarlo.';
    throw Object.assign(new Error(message), { code: 'INVALID_API_RESPONSE', status: response.status });
  }
}
