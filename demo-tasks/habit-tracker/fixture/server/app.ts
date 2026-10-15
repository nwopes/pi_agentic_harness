import express, { type Express } from 'express';

/**
 * Builds the API application. Every call must return an app with its own,
 * fresh in-memory data (nothing is shared between apps).
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // TODO: habit routes

  return app;
}
