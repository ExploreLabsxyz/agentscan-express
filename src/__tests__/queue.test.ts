import { describe, it, expect } from '@jest/globals';
import PQueue from 'p-queue';

describe('Queue Test Suite', () => {
  it('should import and instantiate p-queue', () => {
    const queue = new PQueue({concurrency: 1});
    expect(queue).toBeDefined();
    expect(queue).toBeInstanceOf(PQueue);
  });

  it('should handle async queue operations', async () => {
    const queue = new PQueue({concurrency: 1});
    const result = await queue.add(() => Promise.resolve(42));
    expect(result).toBe(42);
  });
});
