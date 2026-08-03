import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ForwardedLabel } from './ForwardedLabel';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === 'string') return strings;
    return strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), '');
  },
}));

vi.mock('@ionic/react', () => ({
  IonIcon: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

describe('ForwardedLabel', () => {
  it('renders forwarded label with sender name', () => {
    const html = renderToStaticMarkup(<ForwardedLabel name="Alice" />);
    expect(html).toContain('Forwarded from Alice');
  });

  it('renders forwarded label with Unknown fallback when name is null', () => {
    const html = renderToStaticMarkup(<ForwardedLabel name={null} />);
    expect(html).toContain('Forwarded from Unknown');
  });

  it('renders forwarded label with Unknown fallback when name is undefined', () => {
    const html = renderToStaticMarkup(<ForwardedLabel name={undefined} />);
    expect(html).toContain('Forwarded from Unknown');
  });

  it('renders as div by default', () => {
    const html = renderToStaticMarkup(<ForwardedLabel name="Alice" />);
    expect(html).toMatch(/^<div/);
  });

  it('renders as span when as="span"', () => {
    const html = renderToStaticMarkup(<ForwardedLabel name="Alice" as="span" />);
    expect(html).toMatch(/^<span/);
  });
});
