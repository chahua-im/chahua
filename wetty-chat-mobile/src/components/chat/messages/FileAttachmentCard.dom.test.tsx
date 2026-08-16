import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileAttachmentCard } from './FileAttachmentCard';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string, ...values: string[]) =>
    typeof strings === 'string'
      ? strings
      : strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ''}`, ''),
}));

vi.mock('@ionic/react', () => ({
  IonIcon: () => null,
  IonProgressBar: ({ value }: { value: number }) => <div data-upload-progress-bar={value} />,
}));

vi.mock('ionicons/icons', () => ({ documentOutline: 'document-outline' }));
vi.mock('./FileAttachmentCard.module.scss', () => ({ default: {} }));

const attachment = {
  id: 'attachment-1',
  url: 'https://example.test/report.pdf',
  kind: 'application/pdf',
  size: 1024,
  fileName: 'report.pdf',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('FileAttachmentCard', () => {
  it('shows upload progress without an interactive download link', () => {
    act(() => {
      root.render(<FileAttachmentCard attachment={attachment} interactive uploadProgress={40} />);
    });
    expect(container.querySelector('[data-upload-progress-bar]')).not.toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders a download link after upload completes', () => {
    act(() => {
      root.render(<FileAttachmentCard attachment={attachment} interactive />);
    });
    expect(container.querySelector('[data-upload-progress-bar]')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe('Download report.pdf');
  });
});
