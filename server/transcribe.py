"""Local speech recognition. Audio stays on this server."""
import json
import sys
import os
import av
import numpy as np
from faster_whisper import WhisperModel

# Decode through PyAV explicitly to support its current API and bound duration.
resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
parts = []
samples = 0
with av.open(sys.argv[1], mode='r') as container:
    for frame in container.decode(audio=0):
        for converted in resampler.resample(frame):
            block = converted.to_ndarray().flatten()
            samples += len(block)
            if samples > 75 * 16000:
                raise ValueError('Audio exceeds 75 seconds')
            parts.append(block)
    for converted in resampler.resample(None):
        parts.append(converted.to_ndarray().flatten())
if not parts:
    raise ValueError('Empty audio')
audio = np.concatenate(parts).astype(np.float32) / 32768.0
model = WhisperModel(os.environ.get('WHISPER_MODEL', 'small'), device='cpu', compute_type='int8', cpu_threads=4)
segments, info = model.transcribe(audio, language='es', beam_size=3, vad_filter=True)
text = ' '.join(segment.text.strip() for segment in segments).strip()
print(json.dumps({'text': text}, ensure_ascii=False))
