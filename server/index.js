import { createApplication } from './app.js';
const { app, db } = await createApplication();
const port = Number(process.env.PORT || 3086);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`Foodtrack: http://${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
