import type { RenderShortSide } from '../config/env.ts';
import type { SourceVideo } from '../contract.ts';

const MAX_OUTPUT_FRAME_RATE = 60;

export interface OutputFormat {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

/**
 * Format de l'export (contrat) : dimensions de la source, réduites si besoin pour que le
 * petit côté ≤ maxShortSide et le grand côté ≤ 16/9 de cette valeur, proportions conservées,
 * arrondies au pair inférieur ; cadence de la source plafonnée à 60.
 */
export function outputFormat(
  source: Pick<SourceVideo, 'width' | 'height' | 'frameRate'>,
  maxShortSide: RenderShortSide,
): OutputFormat {
  const maxLongSide = Math.round((maxShortSide * 16) / 9);
  const scale = Math.min(
    1,
    maxShortSide / Math.min(source.width, source.height),
    maxLongSide / Math.max(source.width, source.height),
  );
  const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);
  return {
    width: even(source.width * scale),
    height: even(source.height * scale),
    frameRate: Math.min(MAX_OUTPUT_FRAME_RATE, Math.round(source.frameRate * 1000) / 1000),
  };
}

/** Plus grand côté de l'export : les B-rolls sont téléchargés à cette taille, pas au-delà. */
export function outputLongSide(source: Pick<SourceVideo, 'width' | 'height' | 'frameRate'>, maxShortSide: RenderShortSide): number {
  const { width, height } = outputFormat(source, maxShortSide);
  return Math.max(width, height);
}
