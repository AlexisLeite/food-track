import { REQUEST_ERROR_MESSAGE } from './errors.js';
export async function readApiResponse(response) {
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid API response');
    return data.error ? { ...data, error: REQUEST_ERROR_MESSAGE } : data;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw Object.assign(new Error(REQUEST_ERROR_MESSAGE), { code: 'INVALID_API_RESPONSE', status: response.status });
  }
}
