import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config.js';

describe('parseEnv', () => {
  it('reads KEY=VALUE lines with quotes, comments and export prefixes', () => {
    expect(parseEnv('# c\nexport A=1\nB="two words"\nC=\'3\'\n\nbad line\n')).toEqual({ A: '1', B: 'two words', C: '3' });
  });
});
