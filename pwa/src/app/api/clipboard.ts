/**
 * Copy text to the clipboard. Insecure contexts and some webviews have no asynchronous clipboard
 * API, where the hidden textarea command is the only way to write.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.append(field);
  field.focus();
  field.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard is unavailable');
  } finally {
    field.remove();
  }
}
