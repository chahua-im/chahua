import styles from './ReactionPill.module.scss';
import type { ReactionSummary } from '@/api/messages';

type ReactionPillProps = {
  reaction: ReactionSummary;
  isSent?: boolean;
  interactive?: boolean;
  onToggle?: (emoji: string, reactedByMe: boolean) => void;
};

export function ReactionPill({ reaction, isSent = false, interactive = false, onToggle }: ReactionPillProps) {
  const className = [
    styles.reactionPill,
    reaction.reactedByMe ? styles.reactionPillActive : '',
    isSent ? styles.reactionPillSent : '',
    isSent && reaction.reactedByMe ? styles.reactionPillSentActive : '',
    !interactive ? styles.reactionPillReadOnly : '',
  ]
    .filter(Boolean)
    .join(' ');
  const content = (
    <>
      <span className={styles.reactionEmoji}>{reaction.emoji}</span>
      {reaction.reactors && reaction.reactors.length > 0 ? (
        <span className={styles.reactorAvatars}>
          {reaction.reactors.slice(0, 5).map((reactor, i) => (
            <img
              key={reactor.uid}
              src={reactor.avatarUrl ?? undefined}
              alt=""
              className={styles.reactorAvatar}
              style={{ marginLeft: i > 0 ? -9 : 0, zIndex: 5 - i }}
            />
          ))}
          {reaction.count > 5 && <span className={styles.reactorOverflow}>+{reaction.count - 5}</span>}
        </span>
      ) : (
        reaction.count > 1 && <span className={styles.reactionCount}>{reaction.count}</span>
      )}
    </>
  );

  if (!interactive) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button
      type="button"
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.(reaction.emoji, !!reaction.reactedByMe);
      }}
    >
      {content}
    </button>
  );
}
