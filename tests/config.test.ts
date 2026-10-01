import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integerSetting } from '../packages/shared/src/config';

test('integer settings use defaults and reject malformed or out-of-range values', (t) => {
  const original = process.env.TEST_INTEGER_SETTING;
  t.after(() => {
    if (original === undefined) delete process.env.TEST_INTEGER_SETTING;
    else process.env.TEST_INTEGER_SETTING = original;
  });

  delete process.env.TEST_INTEGER_SETTING;
  assert.equal(integerSetting('TEST_INTEGER_SETTING', 3000, 1, 65535), 3000);

  for (const value of ['0', '65536', '-1', '2.5', 'invalid']) {
    process.env.TEST_INTEGER_SETTING = value;
    assert.throws(
      () => integerSetting('TEST_INTEGER_SETTING', 3000, 1, 65535),
      /Invalid configuration: TEST_INTEGER_SETTING/,
    );
  }

  process.env.TEST_INTEGER_SETTING = '8080';
  assert.equal(integerSetting('TEST_INTEGER_SETTING', 3000, 1, 65535), 8080);
});
