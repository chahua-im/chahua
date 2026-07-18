import styles from './ChatBubble.module.scss';

// Build the row-container class for a message row. Centralised so `focused`
// is never accidentally omitted when adding a new bubble type (it was before —
// sticker/invite forgot to forward it and silently never highlighted).
export function rowClassName(base: string, isSent: boolean, focused: boolean | undefined): string {
  return `${base} ${isSent ? styles.sent : styles.received} ${focused ? styles.focused : ''}`.trim();
}
