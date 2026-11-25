import { describe, expect, it } from 'vitest';
import { dimsKey, rollupId } from '../src/storage/mongodb/collections.js';
import { databaseName } from '../src/storage/mongodb/connect.js';

describe('MongoDB storage helpers', () => {
  it('uses the database the URL names, or shardlens', () => {
    expect(databaseName('mongodb://localhost:27017')).toBe('shardlens');
    expect(databaseName('mongodb://localhost:27017/')).toBe('shardlens');
    expect(databaseName('mongodb://user:pw@a:27017,b:27017/mybot?replicaSet=rs0')).toBe('mybot');
    expect(databaseName('mongodb+srv://user:pw@cluster0.example.mongodb.net/bot%20db?retryWrites=true')).toBe('bot db');
  });

  it('keys dimensions the same whatever order they were built in', () => {
    expect(dimsKey({ command: 'ping', kind: 1, outcome: 0 })).toBe(dimsKey({ outcome: 0, kind: 1, command: 'ping' }));
    expect(dimsKey({ command: 'ping' })).not.toBe(dimsKey({ command: 'pong' }));
    expect(dimsKey({})).toBe('{}');
  });

  it('gives each rollup document one ID per app, metric, bucket and dimensions', () => {
    const bucket = new Date('2026-11-24T10:00:00Z');
    const a = rollupId('1', 'interactions', bucket, '{}');
    expect(a.buffer).toEqual(rollupId('1', 'interactions', new Date(bucket), '{}').buffer);
    expect(a.buffer).not.toEqual(rollupId('2', 'interactions', bucket, '{}').buffer);
    expect(a.buffer).not.toEqual(rollupId('1', 'interactions', new Date(bucket.getTime() + 60_000), '{}').buffer);
  });
});
