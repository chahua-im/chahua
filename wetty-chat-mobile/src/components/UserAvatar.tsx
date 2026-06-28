import { forwardRef } from 'react';
import { IonIcon } from '@ionic/react';
import { personCircle } from 'ionicons/icons';
import styles from './UserAvatar.module.scss';
import { colorForUser } from '@/utils/userColor';

interface UserAvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: number;
  fallback?: 'initials' | 'icon';
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
}

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * The avatar's root element is the div carrying `styles.avatar`; the forwarded
 * ref targets that div so callers (e.g. SenderGroup's sticky avatar) can mutate
 * its style directly (transform during swipe) without triggering React re-renders.
 */
export const UserAvatar = forwardRef<HTMLDivElement, UserAvatarProps>(function UserAvatar(
  { name, avatarUrl, size = 36, fallback = 'initials', className, style, onClick },
  ref,
) {
  const base: React.CSSProperties = {
    width: size,
    height: size,
    ...style,
  };
  const classes = [styles.avatar, onClick ? styles.clickable : null, className].filter(Boolean).join(' ');

  if (avatarUrl) {
    return (
      <div ref={ref} className={classes} style={base} onClick={onClick}>
        <img src={avatarUrl} alt="" className={styles.image} />
      </div>
    );
  }

  if (fallback === 'icon') {
    return (
      <div
        ref={ref}
        className={`${classes} ${styles.iconFallback}`}
        style={{
          ...base,
          fontSize: size,
        }}
        onClick={onClick}
      >
        <IonIcon icon={personCircle} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={`${classes} ${styles.fallback}`}
      style={{
        ...base,
        backgroundColor: colorForUser(name),
        fontSize: Math.round(size * 0.36),
      }}
      onClick={onClick}
    >
      {getInitials(name)}
    </div>
  );
});
