import { IonIcon } from '@ionic/react';
import { UserAvatar } from '@/components/UserAvatar';
import styles from './OverlayAvatar.module.scss';

interface OverlayAvatarProps {
  primaryName: string;
  primaryAvatarUrl?: string | null;
  secondaryName?: string | null;
  secondaryAvatarUrl?: string | null;
  /** When set, the secondary corner renders this icon badge instead of a second avatar. */
  secondaryIcon?: string;
  size?: number;
  secondarySize?: number;
  className?: string;
}

export function OverlayAvatar({
  primaryName,
  primaryAvatarUrl,
  secondaryName,
  secondaryAvatarUrl,
  secondaryIcon,
  size = 40,
  secondarySize = Math.max(16, Math.round(size * 0.55)),
  className,
}: OverlayAvatarProps) {
  const classes = [styles.container, className].filter(Boolean).join(' ');

  return (
    <div className={classes} style={{ width: size, height: size }}>
      <UserAvatar name={primaryName} avatarUrl={primaryAvatarUrl} size={size} />
      {secondaryIcon ? (
        <div
          className={`${styles.secondary} ${styles.iconBadge}`}
          style={{ width: secondarySize, height: secondarySize }}
        >
          <IonIcon icon={secondaryIcon} className={styles.secondaryIcon} />
        </div>
      ) : secondaryName ? (
        <div className={styles.secondary}>
          <UserAvatar name={secondaryName} avatarUrl={secondaryAvatarUrl} size={secondarySize} />
        </div>
      ) : null}
    </div>
  );
}
