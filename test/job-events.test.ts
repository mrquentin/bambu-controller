import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectEvents, jobSnapshot } from '../server/bambu/job-events.ts';

const snap = (state: Record<string, unknown>) => jobSnapshot(state);
const types = (prev: Record<string, unknown> | null, next: Record<string, unknown>) =>
  detectEvents(prev && snap(prev), snap(next)).map((e) => e.type);

describe('job lifecycle events', () => {
  it('adopts a job already running on first sight, flagged as observed midway', () => {
    const [event] = detectEvents(null, snap({ gcode_state: 'RUNNING', subtask_name: 'Benchy' }));
    assert.equal(event.type, 'job_started');
    assert.equal(event.type === 'job_started' && event.observedMidway, true);
    assert.deepEqual(types(null, { gcode_state: 'IDLE' }), []);
  });

  it('follows a normal print', () => {
    assert.deepEqual(types({ gcode_state: 'IDLE' }, { gcode_state: 'PREPARE' }), ['job_started']);
    assert.deepEqual(types({ gcode_state: 'PREPARE' }, { gcode_state: 'RUNNING' }), []);
    assert.deepEqual(types({ gcode_state: 'RUNNING' }, { gcode_state: 'PAUSE' }), ['job_paused']);
    assert.deepEqual(types({ gcode_state: 'PAUSE' }, { gcode_state: 'RUNNING' }), ['job_resumed']);
    assert.deepEqual(types({ gcode_state: 'RUNNING' }, { gcode_state: 'FINISH' }), ['job_finished']);
    assert.deepEqual(types({ gcode_state: 'RUNNING' }, { gcode_state: 'FAILED' }), ['job_failed']);
    assert.deepEqual(types({ gcode_state: 'FINISH' }, { gcode_state: 'PREPARE' }), ['job_started']);
  });

  it('does not report an end for a printer that was idle', () => {
    assert.deepEqual(types({ gcode_state: 'IDLE' }, { gcode_state: 'FINISH' }), []);
  });

  it('detects a new job that starts without an idle state in between', () => {
    assert.deepEqual(
      types({ gcode_state: 'RUNNING', subtask_name: 'a' }, { gcode_state: 'RUNNING', subtask_name: 'b' }),
      ['job_started'],
    );
  });

  it('reports only newly raised HMS alerts', () => {
    const prev = { gcode_state: 'RUNNING', hms: [{ attr: 1, code: 2 }] };
    const next = { gcode_state: 'RUNNING', hms: [{ attr: 1, code: 2 }, { attr: 3, code: 4 }] };
    const events = detectEvents(snap(prev), snap(next));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].type === 'hms_raised' && events[0].alerts, [{ attr: 3, code: 4 }]);
    assert.deepEqual(types(next, prev), []);
  });
});
