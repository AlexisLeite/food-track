import test from 'node:test';
import assert from 'node:assert/strict';
import { withRequestLog, executionLogger } from '../server/execution-log.js';

test('concurrent execution logs retain their request identity through async callbacks', async () => {
  const lines = [], original = console.info;
  console.info = line => lines.push(JSON.parse(line));
  try {
    await Promise.all(['request-a', 'request-b'].map(requestId => withRequestLog(requestId, async () => {
      const log = executionLogger('test_execution');
      log('started');
      await new Promise(resolve => setTimeout(resolve, 1));
      log('completed', { exitCode: 0 });
    })));
    for (const requestId of ['request-a', 'request-b']) {
      const events = lines.filter(line => line.requestId === requestId);
      assert.deepEqual(events.map(line => line.phase), ['started', 'completed']);
      assert.equal(events[0].executionId, events[1].executionId);
      assert.ok(events[1].elapsedMs >= events[0].elapsedMs);
      assert.ok(events.every(line => !Number.isNaN(Date.parse(line.timestamp))));
    }
    assert.notEqual(lines[0].executionId, lines[1].executionId);
  } finally { console.info = original; }
});
