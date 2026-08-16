import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentDrawer } from './AttachmentDrawer';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));

vi.mock('@ionic/react', () => ({
  IonIcon: () => null,
}));

vi.mock('ionicons/icons', () => ({
  documentOutline: 'document-outline',
  imageOutline: 'image-outline',
}));

vi.mock('@/features', () => ({
  isFeatureEnabled: () => true,
}));

vi.mock('./AttachmentDrawer.module.scss', () => ({ default: {} }));

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

describe('AttachmentDrawer', () => {
  it('renders image and file tiles only while open and invokes their callbacks', () => {
    const onPickImage = vi.fn<() => void>();
    const onPickFile = vi.fn<() => void>();

    act(() => {
      root.render(<AttachmentDrawer isOpen={false} onPickImage={onPickImage} onPickFile={onPickFile} />);
    });
    expect(container.querySelector('[data-attachment-drawer]')).toBeNull();

    act(() => {
      root.render(<AttachmentDrawer isOpen onPickImage={onPickImage} onPickFile={onPickFile} />);
    });
    const tiles = container.querySelectorAll('button');
    expect([...tiles].map((tile) => tile.textContent)).toEqual(['Image', 'File']);

    act(() => {
      tiles[0].click();
      tiles[1].click();
    });
    expect(onPickImage).toHaveBeenCalledOnce();
    expect(onPickFile).toHaveBeenCalledOnce();
  });
});
