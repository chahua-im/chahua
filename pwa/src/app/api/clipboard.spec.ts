import { copyText } from './clipboard';

describe('copyText', () => {
  it('uses the asynchronous clipboard when the browser exposes it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyText('已复制');
    expect(writeText).toHaveBeenCalledWith('已复制');
  });

  it('selects a temporary field when the asynchronous clipboard is missing', async () => {
    vi.stubGlobal('navigator', {});
    let selected: string | undefined;
    const execCommand = vi.fn(() => {
      selected = document.querySelector('textarea')?.value;
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    await copyText('降级复制');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe('降级复制');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('uses the contentEditable range selection on iOS, where a selected field silently fails', async () => {
    vi.stubGlobal('navigator', { userAgent: 'iPhone', maxTouchPoints: 5 });
    let selected: string | undefined;
    const execCommand = vi.fn(() => {
      const field = document.querySelector('textarea')!;
      selected = field.getAttribute('contenteditable') === 'true' ? field.value : undefined;
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    await copyText('iOS 复制');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selected).toBe('iOS 复制');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('fails when neither clipboard path can write', async () => {
    vi.stubGlobal('navigator', {});
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    await expect(copyText('无法复制')).rejects.toThrow();
    expect(document.querySelector('textarea')).toBeNull();
  });
});
