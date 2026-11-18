import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogLevel } from '../src/config/env.ts';
import { createLogger } from '../src/utils/logger.ts';

function captureLogger(minLevel: LogLevel = 'debug') {
  const lines: Array<{ level: LogLevel; entry: Record<string, unknown>; raw: string }> = [];
  const logger = createLogger(minLevel, { service: 'test' }, (level, raw) => {
    lines.push({ level, raw, entry: JSON.parse(raw) as Record<string, unknown> });
  });
  return { logger, lines };
}

describe('logger', () => {
  it('écrit une ligne JSON avec horodatage, niveau, événement et champs', () => {
    const { logger, lines } = captureLogger();

    logger.info('project.created', { projectId: 'p1' });

    assert.equal(lines.length, 1);
    const entry = lines[0]?.entry;
    assert.equal(entry?.level, 'info');
    assert.equal(entry?.event, 'project.created');
    assert.equal(entry?.service, 'test');
    assert.equal(entry?.projectId, 'p1');
    assert.match(String(entry?.time), /^\d{4}-\d{2}-\d{2}T/);
  });

  it('ignore les messages sous le niveau minimal', () => {
    const { logger, lines } = captureLogger('warn');

    logger.debug('ignored');
    logger.info('ignored');
    logger.warn('kept');

    assert.deepEqual(lines.map((line) => line.entry.event), ['kept']);
  });

  it('masque les champs sensibles, les clés dans les URL et les jetons Bearer', () => {
    const { logger, lines } = captureLogger();

    logger.info('provider.call', {
      apiKey: 'sk-123456',
      url: 'https://pixabay.com/api/videos/?key=abc123&q=forest',
      nested: { authorization: 'Bearer xyz789', note: 'header Bearer tok-456' },
    });

    const raw = lines[0]?.raw ?? '';
    assert.doesNotMatch(raw, /sk-123456|abc123|xyz789|tok-456/);
    assert.match(raw, /key=\[REDACTED\]&q=forest/);
  });

  it('sérialise une erreur avec sa stack pour les logs serveur', () => {
    const { logger, lines } = captureLogger();

    logger.error('job.failed', { err: new Error('ffmpeg a échoué') });

    const err = lines[0]?.entry.err as Record<string, unknown> | undefined;
    assert.equal(err?.message, 'ffmpeg a échoué');
    assert.match(String(err?.stack), /Error: ffmpeg a échoué/);
  });

  it('ajoute les champs du logger enfant', () => {
    const { logger, lines } = captureLogger();

    logger.child({ requestId: 'r-1' }).info('child.event');

    assert.equal(lines[0]?.entry.requestId, 'r-1');
    assert.equal(lines[0]?.entry.service, 'test');
  });
});
