import { EmojiFlagCacheService } from '@nicematic/emoji-picker';

export class PickerFlags extends EmojiFlagCacheService {
  // Cells already use loading="lazy". The eager preload also requires requestIdleCallback,
  // which is unavailable in Safari; leave loading to the visible flag images instead.
  override preloadFlags(_chars: string[]): void {}
}
