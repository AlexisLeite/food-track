"""Short voice-message transcription with an audible-only VAD fallback."""
import numpy as np


def transcribe_samples(model, audio):
    duration = len(audio) / 16000
    rms = float(np.sqrt(np.mean(audio ** 2))) if len(audio) else 0.0
    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    segments, info = model.transcribe(
        audio, language='es', beam_size=3, vad_filter=True,
        vad_parameters={'threshold': 0.35, 'speech_pad_ms': 400},
        condition_on_previous_text=False,
    )
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    speech_seconds = info.duration_after_vad
    # Retry short, audible messages only; pure silence must never become a meal.
    fallback = not text and speech_seconds == 0 and 0.25 <= duration <= 15 and rms >= 0.001 and peak >= 0.01
    if fallback:
        segments, _ = model.transcribe(
            audio, language='es', beam_size=3, vad_filter=False,
            condition_on_previous_text=False, temperature=0,
        )
        text = ' '.join(segment.text.strip() for segment in segments).strip()
    return {'text': text, 'durationSeconds': round(duration, 2),
            'speechSeconds': round(speech_seconds, 2), 'rms': round(rms, 6),
            'peak': round(peak, 6), 'vadFallback': bool(fallback)}
