import { createApplication } from './app.js';
import { startAudioArchiveWorker } from './audio-archive.js';
import { resolve } from 'node:path';
const { app, db, photoStorage } = await createApplication();
const stopAudioArchive = startAudioArchiveWorker(resolve(process.env.DATA_DIR || 'data'));
const stopPhotos = photoStorage.start();
const port = Number(process.env.PORT || 3086);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`Foodtrack: http://${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopAudioArchive();
  stopPhotos();
  server.close(() => { db.close(); process.exit(0); });
});
