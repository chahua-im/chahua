import type { CSSProperties } from 'react';
import { IonFab, IonFabButton, IonIcon } from '@ionic/react';
import { formatUnreadBadge } from '@/utils/unreadBadge';

interface UnreadJumpFabProps {
  /** Fab positioning class, e.g. `mention-fab` or `reaction-fab`. */
  className: string;
  icon: string;
  ariaLabel: string;
  unreadCount: number;
  onClick: () => void;
  visible: boolean;
  /** How many visible FABs sit below this one; each lifts this FAB by 56px. */
  lift: number;
}

/**
 * Jump FAB shared by the mention and reaction jumpers: positioned by
 * `className` and lifted above the FABs stacked below it via `lift`, shows the
 * unread badge when present, hidden via the `--hidden` modifier when the jump
 * target list is empty.
 */
export function UnreadJumpFab({ className, icon, ariaLabel, unreadCount, onClick, visible, lift }: UnreadJumpFabProps) {
  return (
    <IonFab
      vertical="bottom"
      horizontal="end"
      className={`${className} ${visible ? '' : `${className}--hidden`}`}
      style={{ '--fab-lift': `${lift * 56}px` } as CSSProperties}
    >
      {unreadCount > 0 && <span className={`${className}__badge`}>{formatUnreadBadge(unreadCount)}</span>}
      <IonFabButton size="small" onClick={onClick} aria-label={ariaLabel}>
        <IonIcon icon={icon} />
      </IonFabButton>
    </IonFab>
  );
}
