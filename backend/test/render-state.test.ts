import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RenderJobRow } from '../src/contract.ts';
import { toRenderState } from '../src/services/render-state.ts';

function row(overrides: Partial<RenderJobRow> = {}): RenderJobRow {
  return {
    id: 'job-1',
    project_id: 'projet-1',
    project_revision: 3,
    status: 'rendering',
    payload: '{}',
    progress: 0.5,
    attempts: 1,
    max_attempts: 2,
    worker_id: 'worker-1',
    lease_expires_at_ms: 70_000,
    output_size_bytes: null,
    output_duration_seconds: null,
    error_code: null,
    error_message: null,
    created_at_ms: 1_000,
    updated_at_ms: 2_000,
    started_at_ms: 2_000,
    completed_at_ms: null,
    ...overrides,
  };
}

describe('toRenderState', () => {
  it('renvoie un état idle sans job', () => {
    assert.deepEqual(toRenderState(null), {
      status: 'idle',
      jobId: null,
      revision: null,
      progress: 0,
      outputFile: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });
  });

  it("affiche 100 % pour un export terminé, quelle que soit la dernière progression écrite (BUG-QA-001)", () => {
    const state = toRenderState(
      row({ status: 'completed', progress: 0.8, output_size_bytes: 1_000, output_duration_seconds: 30, completed_at_ms: 9_000 }),
    );

    assert.equal(state.progress, 1);
    assert.deepEqual(state.outputFile, { sizeBytes: 1_000, durationSeconds: 30 });
  });

  it("affiche 0 % pour un job en préparation ou remis en file (QA-OBS-002)", () => {
    assert.equal(toRenderState(row({ status: 'queued', progress: 0.42 })).progress, 0);
    assert.equal(toRenderState(row({ status: 'preparing', progress: 0.42 })).progress, 0);
  });

  it('borne la progression publiée pendant le rendu', () => {
    assert.equal(toRenderState(row({ progress: 0.42 })).progress, 0.42);
    assert.equal(toRenderState(row({ progress: 1.7 })).progress, 1);
    assert.equal(toRenderState(row({ progress: -0.2 })).progress, 0);
  });

  it("n'accepte dans un échec de rendu que des codes RENDER_* ou INTERNAL_ERROR (QA-OBS-003)", () => {
    const failed = (errorCode: string | null) =>
      toRenderState(row({ status: 'failed', error_code: errorCode as RenderJobRow['error_code'] })).error;

    assert.equal(failed('RENDER_TIMEOUT')?.code, 'RENDER_TIMEOUT');
    assert.equal(failed('INTERNAL_ERROR')?.code, 'INTERNAL_ERROR');
    assert.equal(failed('NOT_FOUND')?.code, 'INTERNAL_ERROR');
    assert.equal(failed('CODE_INVENTE')?.code, 'INTERNAL_ERROR');
    assert.equal(failed(null)?.code, 'INTERNAL_ERROR');
  });

  it("signale qu'un job invalide ne sert à rien de relancer, contrairement aux autres échecs", () => {
    const invalid = toRenderState(row({ status: 'failed', error_code: 'RENDER_INVALID_JOB' })).error;
    const lost = toRenderState(row({ status: 'failed', error_code: 'RENDER_WORKER_LOST' })).error;

    assert.equal(invalid?.retryable, false);
    assert.equal(lost?.retryable, true);
    assert.equal(lost?.stage, 'render');
    assert.ok(lost?.message);
  });
});
