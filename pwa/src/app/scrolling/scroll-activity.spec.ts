import { scrollActivity } from './scroll-activity';

describe('scrollActivity', () => {
  it('waits for inertia after the finger lifts', async () => {
    const activity = scrollActivity();
    activity.touchStart();
    activity.scrollStart();
    expect(activity.moving()).toBe(true);
    const done = vi.fn();
    const waiting = activity.wait().then(done);
    activity.touchEnd();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    activity.scrollEnd();
    expect(activity.moving()).toBe(false);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
  });

  it('does not insert while the finger is held still', async () => {
    const activity = scrollActivity();
    activity.touchStart();
    activity.scrollStart();
    expect(activity.moving()).toBe(true);
    const done = vi.fn();
    const waiting = activity.wait().then(done);
    activity.scrollEnd();
    expect(activity.moving()).toBe(false);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    activity.touchEnd();
    await waiting;
    expect(done).toHaveBeenCalledOnce();
  });

  it('releases a pending page on navigation and can be reused', async () => {
    const activity = scrollActivity();
    activity.scrollStart();
    expect(activity.moving()).toBe(true);
    const waiting = activity.wait();
    expect(activity.wait()).toBe(waiting);
    activity.reset();
    expect(activity.moving()).toBe(false);
    await waiting;
    await activity.wait();
    activity.touchStart();
    const next = activity.wait();
    expect(next).not.toBe(waiting);
    activity.touchEnd();
    await next;
  });
});
