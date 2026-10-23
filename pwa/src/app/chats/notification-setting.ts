import { GroupKind, type NotificationSettingsResponse } from '../../generated/models';

/** Temporary mute takes precedence; expiry restores the saved override or account default. */
export function notificationMuted(
  kind: GroupKind | undefined,
  setting: { mutedUntil?: string; muteOverride?: boolean } | undefined,
  defaults?: NotificationSettingsResponse,
  now = Date.now(),
): boolean {
  return Date.parse(setting?.mutedUntil ?? '') > now || notificationPermanentlyMuted(kind, setting, defaults);
}

/** The preference that remains after a temporary mute expires. */
export function notificationPermanentlyMuted(
  kind: GroupKind | undefined,
  setting: { muteOverride?: boolean } | undefined,
  defaults?: NotificationSettingsResponse,
): boolean {
  return (
    setting?.muteOverride ??
    (kind === GroupKind.dm
      ? (defaults?.muteDirectChatsByDefault ?? false)
      : (defaults?.muteGroupChatsByDefault ?? true))
  );
}
