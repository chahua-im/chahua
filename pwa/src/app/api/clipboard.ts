/**
 * Copy text to the clipboard. Insecure contexts and some webviews have no asynchronous clipboard
 * API, where the hidden textarea command is the only way to write. iOS silently drops copies from
 * a merely selected textarea, so it gets the contentEditable range selection instead.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  // Keep the field perceptible (1px, transparent) but never offscreen: iOS refuses to copy from
  // offscreen fields, and a font size below 16px makes it zoom into the focused field.
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.left = '0';
  field.style.width = '1px';
  field.style.height = '1px';
  field.style.padding = '0';
  field.style.border = 'none';
  field.style.outline = 'none';
  field.style.opacity = '0';
  field.style.fontSize = '16px';
  document.body.append(field);
  field.focus();
  if (isIOS) {
    field.setAttribute('contenteditable', 'true');
    field.readOnly = false;
    const range = document.createRange();
    range.selectNodeContents(field);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    field.setSelectionRange(0, text.length);
  } else {
    field.select();
    field.setSelectionRange(0, text.length);
  }
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard is unavailable');
  } finally {
    field.remove();
  }
}
