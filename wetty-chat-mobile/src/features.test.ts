import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feature gates', () => {
  it('keeps demoPage behind an explicit gate by default', async () => {
    vi.stubGlobal('__FEATURE_GATES_ENABLED__', false);
    const { FEATURES, isFeatureEnabled } = await import('./features');

    expect(FEATURES.demoPage.enabled).toBe(false);
    expect(isFeatureEnabled('demoPage')).toBe(false);
  });

  it('keeps savedMessages controlled by an explicit feature gate', async () => {
    vi.stubGlobal('__FEATURE_GATES_ENABLED__', false);
    const { FEATURES, isFeatureEnabled } = await import('./features');

    expect(FEATURES.savedMessages.enabled).toBe(true);
    expect(isFeatureEnabled('savedMessages')).toBe(true);
  });

  it('registers messageMarkdown default-enabled so Markdown rendering and the format toolbar are active', async () => {
    vi.stubGlobal('__FEATURE_GATES_ENABLED__', false);
    const { FEATURES, isFeatureEnabled } = await import('./features');

    expect(FEATURES.messageMarkdown.enabled).toBe(true);
    expect(isFeatureEnabled('messageMarkdown')).toBe(true);
  });
});
