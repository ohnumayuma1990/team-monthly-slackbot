import { getGreeting } from '../src/index';

describe('getGreeting', () => {
  it('returns appropriate greeting message', () => {
    expect(getGreeting('SlackBot')).toBe('Hello, SlackBot!');
  });
});
