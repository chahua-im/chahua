export enum ChatFontSize {
  Small,
  MediumSmall,
  Medium,
  MediumLarge,
  Large,
}

export function readChatFontSize(): ChatFontSize {
  const value = Number(window.localStorage.getItem('chahua.preferences.chatFontSize') ?? ChatFontSize.Medium);
  return Number.isInteger(value) && value >= ChatFontSize.Small && value <= ChatFontSize.Large
    ? value
    : ChatFontSize.Medium;
}

export const chatFontSizes = ['12px', '14px', '', '18px', '20px'];
