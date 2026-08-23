import { describe, expect, it } from 'vitest';
import { scoreToolCall } from './scorers.js';

const call = (name: string, args: string) => [{ function: { name, arguments: args } }];
describe('scoreToolCall', () => {
  it('full credit for the expected tool with the expected arguments; half for the right tool; zero otherwise', () => {
    expect(scoreToolCall(call('get_weather', '{"city":"Paris","units":"c"}'), { name: 'get_weather', arguments: { city: 'Paris' } })).toBe(1);
    expect(scoreToolCall(call('get_weather', '{"city":"Lyon"}'), { name: 'get_weather', arguments: { city: 'Paris' } })).toBe(0.5);
    expect(scoreToolCall(call('get_weather', 'not json'), { name: 'get_weather', arguments: { city: 'Paris' } })).toBe(0.5);
    expect(scoreToolCall(call('get_time', '{}'), { name: 'get_weather' })).toBe(0);
    expect(scoreToolCall(undefined, { name: 'get_weather' })).toBe(0);
    expect(scoreToolCall(call('get_weather', '{}'), { name: 'get_weather' })).toBe(1);
  });
});
