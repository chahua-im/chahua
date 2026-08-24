import { UserAvatar } from '@/components/UserAvatar';
import styles from './PeerProfileHeader.module.scss';

export function PeerProfileHeader({
  displayName,
  avatarUrl,
  onOpenProfile,
}: {
  displayName: string;
  avatarUrl?: string | null;
  onOpenProfile?: () => void;
}) {
  return (
    <section className={styles.card}>
      <button
        type="button"
        className={styles.avatarButton}
        {...(onOpenProfile ? { onClick: onOpenProfile } : {})}
        disabled={!onOpenProfile}
      >
        <UserAvatar name={displayName} avatarUrl={avatarUrl} size={112} className={styles.avatar} />
      </button>
      <h2 className={styles.title}>{displayName}</h2>
    </section>
  );
}
