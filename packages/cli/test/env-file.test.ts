import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEnvFile, setEnvVariables } from '../src/env-file.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('readEnvFile', () => {
  it('reads the variables without changing the environment, empty values counting as unset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shardlens-env-'));
    dirs.push(dir);
    const file = join(dir, '.env');
    expect(await readEnvFile(file)).toBeUndefined();
    const key = `slk_ingest_${'C'.repeat(43)}`;
    await writeFile(
      file,
      `DISCORD_TOKEN=abc\nSHARDLENS_URL=https://stats.example.com\nSHARDLENS_INGEST_KEY="${key}"\nEMPTY=\n`,
    );
    expect(await readEnvFile(file)).toEqual({
      DISCORD_TOKEN: 'abc',
      SHARDLENS_URL: 'https://stats.example.com',
      SHARDLENS_INGEST_KEY: key,
    });
    expect(process.env.SHARDLENS_INGEST_KEY).not.toBe(key);
  });
});

describe('setEnvVariables', () => {
  it('sets variables in place and keeps comments, quoting and every other line', () => {
    const before = "# comment\nA=1\nexport B='x y'\n# C=old\nD=\n";
    expect(setEnvVariables(before, { A: '2', C: 'new', D: 'd', E: 'e' })).toBe(
      "# comment\nA=2\nexport B='x y'\nC=new\nD=d\nE=e\n",
    );
    expect(setEnvVariables('', { A: '1' })).toBe('A=1\n');
  });

  it('does not take a comment that mentions a variable for the variable', () => {
    expect(setEnvVariables('# Optional: set A=1 to enable\n', { A: '2' })).toBe('# Optional: set A=1 to enable\nA=2\n');
  });
});
