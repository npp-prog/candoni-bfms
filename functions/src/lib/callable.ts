import { randomUUID } from 'node:crypto';
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import { REGION } from './admin';
import { loadCallerContext, toHttpsError, type CallerContext } from './context';

/**
 * Standard secure callable pipeline (docs/architecture/04-accounting-engine.md §8):
 * auth → active user → fresh assignments → zod input → handler (which calls ctx.require …) → error mapping.
 */
export function secureCallable<S extends z.ZodTypeAny, R>(
  schema: S,
  handler: (input: z.infer<S>, ctx: CallerContext, req: CallableRequest) => Promise<R>,
  opts: { timeoutSeconds?: number; memory?: '256MiB' | '512MiB' | '1GiB' } = {},
) {
  return onCall(
    { region: REGION, timeoutSeconds: opts.timeoutSeconds ?? 60, memory: opts.memory ?? '256MiB', enforceAppCheck: false },
    async (req) => {
      if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in.');
      const parsed = schema.safeParse(req.data);
      if (!parsed.success) {
        throw new HttpsError('invalid-argument', 'Invalid request.', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      const requestId = randomUUID();
      try {
        const ctx = await loadCallerContext(req.auth.uid, requestId);
        return await handler(parsed.data, ctx, req);
      } catch (e) {
        throw toHttpsError(e);
      }
    },
  );
}
