import { useSelector } from 'react-redux';
import type { RootState } from '@/store';

export function useHasGlobalPermission(permission: string | string[]): boolean {
  const permissions = useSelector((state: RootState) => state.user.permissions);
  const allowedPermissions = Array.isArray(permission) ? permission : [permission];

  if (permissions.includes('permission.all')) {
    return true;
  }

  return allowedPermissions.some((allowedPermission) => permissions.includes(allowedPermission));
}
