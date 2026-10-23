import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from speech import transcribe_samples


class Model:
    def __init__(self, text='', speech=0):
        self.calls = []
        self.text = text
        self.speech = speech

    def transcribe(self, audio, **kwargs):
        self.calls.append(kwargs)
        text = self.text if kwargs['vad_filter'] else 'Dos huevos'
        return iter([SimpleNamespace(text=text)]), SimpleNamespace(duration_after_vad=self.speech)


class SpeechTest(unittest.TestCase):
    def test_audible_short_message_is_retried_after_vad_discards_it(self):
        model = Model()
        audio = (np.sin(np.arange(64000) * .05) * .03).astype(np.float32)
        result = transcribe_samples(model, audio)
        self.assertEqual(result['text'], 'Dos huevos')
        self.assertTrue(result['vadFallback'])
        self.assertEqual([call['vad_filter'] for call in model.calls], [True, False])

    def test_silence_and_long_messages_do_not_bypass_vad(self):
        for audio in [np.zeros(64000, dtype=np.float32), np.full(16 * 16000, .03, dtype=np.float32)]:
            model = Model()
            result = transcribe_samples(model, audio)
            self.assertEqual(result['text'], '')
            self.assertFalse(result['vadFallback'])
            self.assertEqual(len(model.calls), 1)

    def test_successful_transcription_is_preserved_without_retry(self):
        model = Model(text='Papas medianas', speech=2)
        result = transcribe_samples(model, np.full(64000, .03, dtype=np.float32))
        self.assertEqual(result['text'], 'Papas medianas')
        self.assertFalse(result['vadFallback'])
        self.assertEqual(len(model.calls), 1)


if __name__ == '__main__':
    unittest.main()
