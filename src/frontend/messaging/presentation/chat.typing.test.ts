import { describe, expect, test } from 'bun:test';

import { FakeTimers } from '../connection/messaging.connection.test-support.ts';
import { typingLabel, TypingRoster, TypingThrottle } from './chat.typing.ts';

function setup(): {
  advance: (ms: number) => void;
  sent: Array<[string, boolean]>;
  throttle: TypingThrottle;
  timers: FakeTimers;
} {
  let now = 0;
  const sent: Array<[string, boolean]> = [];
  const timers = new FakeTimers();
  const throttle = new TypingThrottle({
    idleMs: 5000,
    intervalMs: 3000,
    now: () => now,
    send: (roomId, active) => {
      sent.push([roomId, active]);
    },
    timers,
  });
  return {
    advance: (ms) => {
      now += ms;
    },
    sent,
    throttle,
    timers,
  };
}

describe('TypingThrottle', () => {
  test('the first keystroke sends active:true', () => {
    const { sent, throttle } = setup();
    throttle.input('room');

    expect(sent).toEqual([['room', true]]);
  });

  test('keystrokes within 3 s send nothing more; after 3 s active:true is sent again', () => {
    const { advance, sent, throttle } = setup();
    throttle.input('room');
    advance(1000);
    throttle.input('room');
    advance(1999);
    throttle.input('room');

    expect(sent).toEqual([['room', true]]);

    advance(1);
    throttle.input('room');
    expect(sent).toEqual([
      ['room', true],
      ['room', true],
    ]);
  });

  test('going idle sends active:false once', () => {
    const { sent, throttle, timers } = setup();
    throttle.input('room');
    throttle.input('room');

    expect(timers.delays()).toEqual([5000]);
    timers.runNext();
    expect(sent).toEqual([
      ['room', true],
      ['room', false],
    ]);
    expect(timers.delays()).toEqual([]);
  });

  test('stop (on send) sends active:false and cancels the idle timer', () => {
    const { sent, throttle, timers } = setup();
    throttle.input('room');
    throttle.stop();

    expect(sent).toEqual([
      ['room', true],
      ['room', false],
    ]);
    expect(timers.delays()).toEqual([]);
  });

  test('stop while not typing sends nothing', () => {
    const { sent, throttle } = setup();
    throttle.stop();

    expect(sent).toEqual([]);
  });

  test('typing in another room stops the previous room first', () => {
    const { sent, throttle } = setup();
    throttle.input('a');
    throttle.input('b');

    expect(sent).toEqual([
      ['a', true],
      ['a', false],
      ['b', true],
    ]);
  });
});

describe('TypingRoster', () => {
  test('lists active typers until they stop or their entry expires', () => {
    const roster = new TypingRoster(6000);
    roster.set('room', 2, true, 0);
    roster.set('room', 3, true, 1000);

    expect(roster.typingIn('room', 5999)).toEqual([2, 3]);
    expect(roster.typingIn('room', 6000)).toEqual([3]);

    roster.set('room', 3, false, 2000);
    expect(roster.typingIn('room', 2000)).toEqual([2]);
  });

  test('rooms are independent', () => {
    const roster = new TypingRoster(6000);
    roster.set('a', 2, true, 0);

    expect(roster.typingIn('b', 0)).toEqual([]);
  });
});

describe('typingLabel', () => {
  test('names one, two, or several typers', () => {
    expect(typingLabel([])).toBe('');
    expect(typingLabel(['alice'])).toBe('alice is typing…');
    expect(typingLabel(['alice', 'bob'])).toBe('alice and bob are typing…');
    expect(typingLabel(['alice', 'bob', 'carol'])).toBe('Several people are typing…');
  });
});
