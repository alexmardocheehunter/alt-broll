import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { jobFixturePath, mediaPath, PROJECT_ROOT, projectFixturePath } from '../lib/paths.ts';
import { validateApiErrorResponse } from '../lib/validation/api.ts';
import { validateErrorInfo } from '../lib/validation/errors.ts';
import { validateProject } from '../lib/validation/project.ts';
import { validateRenderJobPayload } from '../lib/validation/render-job.ts';

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('contrat : exemples et fixtures', () => {
  const examplePath = path.join(PROJECT_ROOT, 'shared', 'examples', 'project.example.json');

  it('shared/examples/project.example.json respecte shared/contract.ts', () => {
    const body = readJson(examplePath) as { project: unknown };
    assert.deepEqual(validateProject(body.project), []);
  });

  it('l’exemple ne monte que les B-rolls inclus (refusé exclu, proposition D-06)', () => {
    const body = readJson(examplePath) as { project: { timeline: { segments: Array<{ brollItemId: string }> } } };
    const ids = body.project.timeline.segments.map((segment) => segment.brollItemId);
    assert.deepEqual(ids, ['broll_mk01', 'broll_mg02']);
    assert.ok(!ids.includes('broll_sk03'), 'un B-roll refusé ne doit pas figurer dans timeline.segments');
  });

  it('tests/fixtures/projects/project.fixture.json respecte le contrat', () => {
    const body = readJson(projectFixturePath('project.fixture.json')) as { project: unknown };
    assert.deepEqual(validateProject(body.project), []);
  });

  it('la fixture projet applique la règle d’inclusion (refusé + désactivé exclus)', () => {
    const body = readJson(projectFixturePath('project.fixture.json')) as {
      project: { timeline: { segments: Array<{ brollItemId: string }> } };
    };
    const ids = body.project.timeline.segments.map((segment) => segment.brollItemId);
    assert.deepEqual(ids, ['br_fix_01', 'br_fix_02']);
  });

  it('le job de rendu paysage respecte RenderJobPayload', () => {
    const payload = readJson(jobFixturePath('render-job.payload.landscape.json'));
    assert.deepEqual(validateRenderJobPayload(payload), []);
  });

  it('le job de rendu portrait (source avec rotation) respecte RenderJobPayload', () => {
    const payload = readJson(jobFixturePath('render-job.payload.portrait.json'));
    assert.deepEqual(validateRenderJobPayload(payload), []);
  });

  it('les URL des fixtures sont fictives et sans donnée Pixabay réelle', () => {
    const text = readFileSync(projectFixturePath('project.fixture.json'), 'utf8');
    assert.ok(!/pixabay\.com/i.test(text), 'une URL pixabay.com réelle ne doit pas être utilisée dans une fixture');
    assert.ok(!/https:\/\/(?!example\.com)[^"]+\.(?:mp4|jpe?g)/i.test(text), 'les médias de fixture doivent utiliser example.com');
  });

  it('une ErrorInfo valide passe et une erreur inventée est refusée', () => {
    const valid = {
      code: 'VIDEO_TOO_LONG',
      stage: 'upload',
      message: 'La vidéo dure 4 min 12 s ; la limite de la bêta est 3 min.',
      retryable: false,
    };
    assert.deepEqual(validateErrorInfo(valid), []);
    assert.ok(validateErrorInfo({ ...valid, code: 'ERREUR_INVENTEE' }).length > 0);
    assert.ok(validateErrorInfo({ ...valid, stage: 'inconnue' }).length > 0);
  });

  it('une ApiErrorResponse expose code, stage, message, retryable et requestId', () => {
    const valid = {
      error: { code: 'INTERNAL_ERROR', stage: 'internal', message: 'Une erreur interne est survenue.', retryable: true },
      requestId: '6f1c2a9e-1b2c-4d3e-8f90-abcdefabcdef',
    };
    assert.deepEqual(validateApiErrorResponse(valid), []);
    assert.ok(validateApiErrorResponse({ ...valid, requestId: '' }).length > 0);
  });

  it('les fixtures média existent aux emplacements attendus', () => {
    for (const name of ['source-30s.mp4', 'source-rotated-10s.mp4', 'broll-city-8s.mp4']) {
      assert.doesNotThrow(() => mediaPath(name));
    }
    assert.throws(() => mediaPath('../.env'));
    assert.throws(() => mediaPath('..\\source-30s.mp4'));
  });
});
