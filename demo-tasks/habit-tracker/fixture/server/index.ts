import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app';

const port = Number(process.env.API_PORT) || 3001;
const app = createApp();

// `npm start` also serves the production frontend once `npm run build` has created dist/.
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
