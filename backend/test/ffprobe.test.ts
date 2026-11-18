import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interpretProbeOutput, parseFrameRate } from '../src/media/ffprobe.ts';

const MP4_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';

function videoStream(extra: Record<string, unknown> = {}) {
  return { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', ...extra };
}

describe('interpretProbeOutput', () => {
  it('lit la durée, les dimensions, la cadence et les codecs', () => {
    const probe = interpretProbeOutput({
      streams: [videoStream({ avg_frame_rate: '30000/1001' }), { codec_type: 'audio', codec_name: 'aac' }],
      format: { format_name: MP4_FORMAT, duration: '95.429000' },
    });

    assert.deepEqual(probe, {
      formatName: MP4_FORMAT,
      durationSeconds: 95.429,
      video: { codec: 'h264', width: 1920, height: 1080, frameRate: 29.97 },
      audio: { codec: 'aac' },
    });
  });

  it("applique la rotation d'une vidéo de téléphone (matrice d'affichage ou étiquette rotate)", () => {
    const format = { format_name: MP4_FORMAT, duration: '10' };
    const fromSideData = interpretProbeOutput({
      streams: [videoStream({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] })],
      format,
    });
    const fromTag = interpretProbeOutput({ streams: [videoStream({ tags: { rotate: '270' } })], format });
    const halfTurn = interpretProbeOutput({ streams: [videoStream({ side_data_list: [{ rotation: 180 }] })], format });

    assert.deepEqual([fromSideData.video?.width, fromSideData.video?.height], [1080, 1920]);
    assert.deepEqual([fromTag.video?.width, fromTag.video?.height], [1080, 1920]);
    assert.deepEqual([halfTurn.video?.width, halfTurn.video?.height], [1920, 1080]);
  });

  it("ignore une pochette d'album et signale l'absence de piste vidéo", () => {
    const probe = interpretProbeOutput({
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        { codec_type: 'audio', codec_name: 'mp3' },
      ],
      format: { format_name: MP4_FORMAT, duration: '30' },
    });

    assert.equal(probe.video, null);
    assert.deepEqual(probe.audio, { codec: 'mp3' });
  });

  it('se rabat sur la durée de la piste et sur r_frame_rate', () => {
    const probe = interpretProbeOutput({
      streams: [videoStream({ width: 320, height: 240, avg_frame_rate: '0/0', r_frame_rate: '25/1', duration: '12.5' })],
      format: { format_name: MP4_FORMAT },
    });

    assert.equal(probe.durationSeconds, 12.5);
    assert.equal(probe.video?.frameRate, 25);
    assert.equal(probe.audio, null);
  });

  it('rejette une sortie ffprobe mal formée', () => {
    assert.throws(() => interpretProbeOutput({ streams: 'pas une liste' }));
    assert.throws(() => interpretProbeOutput(null));
  });
});

describe('parseFrameRate', () => {
  it('convertit les fractions et refuse les valeurs inexploitables', () => {
    assert.equal(parseFrameRate('30000/1001'), 29.97);
    assert.equal(parseFrameRate('24'), 24);
    assert.equal(parseFrameRate('0/0'), null);
    assert.equal(parseFrameRate('abc'), null);
    assert.equal(parseFrameRate(undefined), null);
  });
});
