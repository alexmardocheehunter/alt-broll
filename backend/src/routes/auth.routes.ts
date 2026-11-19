import { Router } from 'express';
import type { AuthGuards } from '../auth/auth.middleware.ts';
import type { AppConfig } from '../config/env.ts';
import type { AuthSessionResponse } from '../contract.ts';

/** GET /api/auth/session : mode de connexion du serveur et compte reconnu (docs/API.md). */
export function createAuthRouter({ config, guards }: { config: AppConfig; guards: AuthGuards }): Router {
  const router = Router();

  router.get('/auth/session', async (req, res) => {
    const body: AuthSessionResponse = {
      mode: config.auth.mode,
      firebaseProjectId: config.auth.mode === 'firebase' ? config.auth.firebaseProjectId : null,
      user: await guards.optionalUser(req),
    };
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(body);
  });

  return router;
}
