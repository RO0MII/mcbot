'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeRetryDelay } = require('../reconnect-delay');

test('a route failure never parks a bot for minutes', () => {
  for (let attempt = 1; attempt <= 20; attempt++) {
    assert.ok(routeRetryDelay(attempt) <= 30000, `attempt ${attempt} was ${routeRetryDelay(attempt)}ms`);
  }
});

test('route failures still back off before settling at the cap', () => {
  assert.equal(routeRetryDelay(1), 5000);
  assert.equal(routeRetryDelay(2), 10000);
  assert.equal(routeRetryDelay(3), 20000);
  assert.equal(routeRetryDelay(8), 30000);
});
