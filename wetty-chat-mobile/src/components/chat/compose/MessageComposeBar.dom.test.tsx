import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageComposeBar } from './MessageComposeBar';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));

vi.mock('@ionic/react', () => ({
  IonButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  IonIcon: () => null,
}));

vi.mock('ionicons/icons', () => ({
  addCircleOutline: 'add-circle-outline',
  send: 'send',
}));

vi.mock('./AttachmentDrawer', () => ({
  AttachmentDrawer: ({ isOpen, onPickFile }: { isOpen: boolean; onPickFile: () => void }) =>
    isOpen ? (
      <button type="button" onClick={onPickFile}>
        File
      </button>
    ) : null,
}));
vi.mock('./StickerPicker', () => ({ StickerPicker: () => null }));
vi.mock('./AudioRecordButton', () => ({ AudioRecordButton: () => null }));
vi.mock('./ComposeContextBanner', () => ({ ComposeContextBanner: () => null }));
vi.mock('./ComposeInput', () => ({ ComposeInput: () => null }));
vi.mock('./VoiceRecorderPanel', () => ({ VoiceRecorderPanel: () => null }));
vi.mock('./MentionAutocomplete', () => ({ MentionAutocomplete: () => null }));
vi.mock('./UploadPreview', () => ({ UploadPreview: () => null }));
vi.mock('./MessageComposeBar.module.scss', () => ({ default: {} }));
vi.mock('@/hooks/useChatDraft', () => ({
  loadDraft: vi.fn(),
  useChatDraft: () => ({ saveDebounced: vi.fn(), clear: vi.fn() }),
}));
vi.mock('./useComposeAttachments', () => ({
  useComposeAttachments: () => ({
    uploads: [],
    existingAttachments: [],
    previewItems: [],
    hasPending: false,
    hasFailed: false,
    queueFiles: vi.fn(),
    clearAll: vi.fn(),
    removeUpload: vi.fn(),
    retryUpload: vi.fn(),
    removeExistingAttachment: vi.fn(),
  }),
}));
vi.mock('./useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({
    voiceRecorder: null,
    voiceActive: false,
    startVoiceRecording: vi.fn(),
    completeVoiceRecording: vi.fn(),
    cancelVoiceRecording: vi.fn(),
    sendVoiceRecording: vi.fn(),
  }),
}));
vi.mock('./useMentionAutocomplete', () => ({
  useMentionAutocomplete: () => ({
    mentionState: { isOpen: false, results: [], selectedIndex: 0, loading: false, query: '' },
    selectMention: vi.fn(),
    handleKeyDown: vi.fn(),
    toWireFormat: (text: string) => text,
    clearMentions: vi.fn(),
    onTextChange: vi.fn(),
  }),
}));

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

describe('MessageComposeBar attachment drawer', () => {
  it('sends a picked file immediately as a file payload', () => {
    const onSend = vi.fn();
    const uploadAttachment = vi.fn();

    act(() => {
      root.render(<MessageComposeBar onSend={onSend} uploadAttachment={uploadAttachment} />);
    });
    const attachButton = container.querySelector<HTMLButtonElement>('[data-attach-btn]');
    expect(attachButton).not.toBeNull();

    act(() => {
      attachButton!.click();
    });
    const fileTile = [...container.querySelectorAll('button')].find((button) => button.textContent === 'File');
    expect(fileTile).toBeDefined();

    act(() => {
      fileTile!.click();
    });
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const fileInput = inputs[1];
    const file = new File(['x'], 'report.pdf', { type: 'application/pdf' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });

    act(() => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith({ kind: 'file', file });
  });
});
