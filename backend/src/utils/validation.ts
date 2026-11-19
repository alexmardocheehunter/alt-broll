import type { z } from 'zod';
import type { ErrorStage } from '../contract.ts';
import { AppError } from './errors.ts';

/**
 * Valide le corps d'une requête. Le message nomme le premier champ en cause, sans
 * reprendre la valeur reçue ; le détail des problèmes ne va que dans les logs.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, stage: ErrorStage): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const first = result.error.issues[0];
  const field = first === undefined ? '' : first.path.map(String).join('.');
  throw new AppError({
    code: 'VALIDATION_FAILED',
    stage,
    httpStatus: 400,
    message: field === '' ? 'Requête invalide : format inattendu.' : `Requête invalide : le champ « ${field} » est absent, inattendu ou incorrect.`,
    details: { issues: result.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code })) },
  });
}
