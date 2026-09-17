import type { CSSProperties } from 'react';
import { IonFab, IonFabButton, IonIcon } from '@ionic/react';
import { formatUnreadBadge } from '@/utils/unreadBadge';

/**
 * Vertical step between stacked jump FABs. Must stay in sync with the FAB
 * geometry in conversation.scss (48px button + 8px gap above bottom:16px).
 */
const FAB_STACK_STEP_PX = 56;

interface UnreadJumpFabProps {
  /** Fab positioning class, e.g. `mention-fab` or `reaction-fab`. */
  className: string;
  icon: string;
  ariaLabel: string;
  unreadCount: number;
  onClick: () => void;
  visible: boolean;
  /** How many visible FABs sit below this one; each lifts this FAB by FAB_STACK_STEP_PX. */
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
      className={`jump-fab ${className} ${visible ? '' : 'jump-fab--hidden'}`}
      style={{ '--fab-lift': `${lift * FAB_STACK_STEP_PX}px` } as CSSProperties}
    >
      {unreadCount > 0 && <span className="jump-fab__badge">{formatUnreadBadge(unreadCount)}</span>}
      <IonFabButton size="small" onClick={onClick} aria-label={ariaLabel}>
        <IonIcon icon={icon} />
      </IonFabButton>
    </IonFab>
  );
}
