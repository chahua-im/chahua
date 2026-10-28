import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AlertController, ModalController } from '@ionic/angular';
import { HttpClient } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { vi, type MockInstance } from 'vitest';
import { CHAHUA_BASE_URL } from '../../../generated/endpoints/chahua.base-url';
import { StickersService } from '../../../generated/endpoints/stickers/stickers.service';
import type { StickerPackDetailResponse, StickerSummary } from '../../../generated/models';
import { encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { testUser } from '../../api/testing';
import { SessionStore } from '../../session/session-store';
import { StickerPreferences } from '../sticker-preferences';
import { StickerPackDetail } from './sticker-pack-detail';
import { StickerEditor } from '../sticker-editor/sticker-editor';

describe('StickerPackDetail', () => {
  const sticker: StickerSummary = {
    id: encodeId('101'),
    createdAt: '2026-09-08T00:00:00Z',
    emoji: '🍵',
    isFavorited: false,
    media: { id: encodeId('102'), contentType: 'image/png', size: 12, url: 'https://example.test/sticker.png' },
  };
  const pack: StickerPackDetailResponse = {
    id: encodeId('201'),
    name: '我的包',
    createdAt: sticker.createdAt,
    updatedAt: sticker.createdAt,
    ownerUid: 1,
    isSubscribed: true,
    stickerCount: 1,
    stickers: [sticker],
  };
  let api: Record<string, MockInstance>;
  let post: MockInstance;
  let preferences: Record<string, MockInstance | ((...args: unknown[]) => unknown)>;
  let alerts: { create: MockInstance };
  let dismiss: MockInstance;
  let session: SessionStore;

  beforeEach(() => {
    api = {
      getPack: vi.fn(() => of(pack)),
      patchPack: vi.fn(() => of({ ...pack, name: '新名' })),
      deletePack: vi.fn(() => of(undefined)),
      deletePackSticker: vi.fn(() => of(undefined)),
      deleteSubscription: vi.fn(() => of(undefined)),
    };
    post = vi.fn(() => of({ ...sticker, id: encodeId('105') }));
    preferences = {
      removePackOrderItem: vi.fn(),
    };
    alerts = {
      create: vi.fn(async () => ({
        present: async () => {},
        onDidDismiss: async () => ({ role: 'destructive' }),
      })),
    };
    dismiss = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: StickersService, useValue: api },
        { provide: HttpClient, useValue: { post } },
        { provide: CHAHUA_BASE_URL, useValue: '/_api' },
        { provide: ModalController, useValue: { dismiss } },
        { provide: AlertController, useValue: alerts },
        { provide: StickerPreferences, useValue: preferences },
      ],
    });
    TestBed.overrideComponent(StickerEditor, {
      set: { template: '<ion-modal [canDismiss]="canDismiss" />' },
    });
    session = TestBed.inject(SessionStore);
    session.user.set({ ...testUser });
  });

  afterEach(() => TestBed.resetTestingModule());

  function page(packId: SnowflakeID = pack.id) {
    const fixture = TestBed.createComponent(StickerPackDetail);
    fixture.componentRef.setInput('packId', packId);
    fixture.detectChanges();
    return fixture.componentInstance as StickerPackDetail;
  }

  async function loaded() {
    const component = page();
    await vi.waitFor(() => expect(component['pack']()).toBeDefined());
    return component;
  }

  function confirm(role: string) {
    alerts.create.mockImplementationOnce(async () => ({
      present: async () => {},
      onDidDismiss: async () => ({ role }),
    }));
  }

  it('loads the pack and offers rename, delete and add for owned packs', async () => {
    const component = await loaded();
    expect(component['owned']()).toBe(true);
  });

  it('covers each sticker cell until its media paints', async () => {
    const fixture = TestBed.createComponent(StickerPackDetail);
    fixture.componentRef.setInput('packId', pack.id);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.nativeElement.querySelector('.cell img')).not.toBeNull());
    fixture.detectChanges();
    const cells = Array.from(fixture.nativeElement.querySelectorAll('.cell') as NodeListOf<HTMLElement>);
    const cell = cells.find((item) => item.querySelector('img'))!;
    const media = cell.querySelector('img')!;
    expect(cell.querySelector('.cell-skeleton')).not.toBeNull();
    expect(media.classList.contains('loaded')).toBe(false);
    media.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(media.classList.contains('loaded')).toBe(true);
  });

  it('renames through the pack endpoint and updates the title signal', async () => {
    alerts.create.mockImplementationOnce(async () => ({
      present: async () => {},
      onDidDismiss: async () => ({ role: 'confirm', data: { values: { name: ' 新名 ' } } }),
    }));
    const component = await loaded();
    component['rename']();
    await component['saveName']({ name: ' 新名 ', emoji: '' });
    expect(api['patchPack']).toHaveBeenCalledWith(pack.id, { name: '新名' });
    expect(component['pack']()?.name).toBe('新名');
    expect(component['renaming']()).toBe(false);
  });

  it('removes a sticker from an owned pack after confirmation', async () => {
    const component = await loaded();
    await component['removeSticker'](sticker);
    expect(api['deletePackSticker']).toHaveBeenCalledWith(pack.id, sticker.id);
    expect(component['pack']()?.stickers).toEqual([]);
    expect(component['pack']()?.stickerCount).toBe(0);
  });

  it('deletes the pack, drops it from the order and closes the page', async () => {
    const component = await loaded();
    await component['deletePack']();
    expect(api['deletePack']).toHaveBeenCalledWith(pack.id);
    expect(preferences['removePackOrderItem']).toHaveBeenCalledWith(pack.id);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('unsubscribes from a foreign pack and closes the page', async () => {
    const foreign = { ...pack, ownerUid: 2 };
    api['getPack'].mockReturnValueOnce(of(foreign));
    const component = await loaded();
    expect(component['owned']()).toBe(false);
    await component['unsubscribe']();
    expect(api['deleteSubscription']).toHaveBeenCalledWith(pack.id);
    expect(preferences['removePackOrderItem']).toHaveBeenCalledWith(pack.id);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('uploads a sticker with its emoji and appends it to the pack', async () => {
    const component = await loaded();
    alerts.create.mockImplementationOnce(async () => ({
      present: async () => {},
      onDidDismiss: async () => ({ role: 'confirm', data: { values: { emoji: '🍵', name: '茶' } } }),
    }));
    const file = new File(['png-bytes'], 'tea.png', { type: 'image/png' });
    await component['upload']({ target: { files: [file], value: '' } } as unknown as Event);
    expect(component['uploadFile']()).toBeDefined();
    await component['saveSticker']({ emoji: '🍵', name: '茶' });
    expect(post).toHaveBeenCalledOnce();
    const [url, body] = post.mock.calls[0] as [string, FormData];
    expect(url).toBe(`/_api/stickers/packs/201/stickers`);
    expect(body.get('emoji')).toBe('🍵');
    expect(body.get('name')).toBe('茶');
    expect(component['pack']()?.stickers).toHaveLength(2);
    expect(component['uploadFile']()).toBeUndefined();
  });

  it('rejects unsupported or oversized files with an explanation alert', async () => {
    const component = await loaded();
    const blob = new Blob([new ArrayBuffer(10 * 1024 * 1024 + 1)]);
    await component['upload']({
      target: { files: [new File([blob], 'big.bin', { type: 'application/octet-stream' })], value: '' },
    } as unknown as Event);
    expect(post).not.toHaveBeenCalled();
    expect(alerts.create).toHaveBeenLastCalledWith({
      header: '无法添加贴纸',
      message: '请选择 10 MB 以内的图片或 WebM 视频。',
      buttons: ['知道了'],
    });
  });

  it('survives a failed load through the retry path', async () => {
    api['getPack'].mockReturnValueOnce(throwError(() => new Error('offline')));
    const component = page();
    await vi.waitFor(() => expect(component['error']()).toBe(true));
    api['getPack'].mockReturnValueOnce(of(pack));
    await component['retry']();
    expect(component['pack']()).toBeDefined();
  });

  it('retains the rename form on failure and allows retry', async () => {
    const component = await loaded();
    component['rename']();
    api['patchPack'].mockReturnValueOnce(throwError(() => new Error('offline')));
    await component['saveName']({ name: '新名', emoji: '' });
    expect(component['renaming']()).toBe(true);
    expect(component['editorError']()).toBeTruthy();
    expect(component['pack']()?.name).toBe(pack.name);
    await component['saveName']({ name: '新名', emoji: '' });
    expect(component['renaming']()).toBe(false);
    expect(component['pack']()?.name).toBe('新名');
  });

  it('keeps the editor mounted until its successful dismissal finishes', async () => {
    const fixture = TestBed.createComponent(StickerPackDetail);
    fixture.componentRef.setInput('packId', pack.id);
    fixture.detectChanges();
    await fixture.whenStable();
    const component = fixture.componentInstance;
    component['rename']();
    fixture.detectChanges();
    let finish!: (dismissed: boolean) => void;
    const closing = vi.spyOn(component['editor']()!, 'dismiss').mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = component['saveName']({ name: '新名', emoji: '' });
    await vi.waitFor(() => expect(closing).toHaveBeenCalledOnce());
    expect(component['renaming']()).toBe(true);
    expect(component['busy']()).toBe(true);
    finish(true);
    await saving;
    expect(component['renaming']()).toBe(false);
    expect(component['busy']()).toBe(false);
  });

  it('retains the selected upload after failure so it can be retried', async () => {
    const component = await loaded();
    const file = new File(['png-bytes'], 'tea.png', { type: 'image/png' });
    await component['upload']({ target: { files: [file], value: '' } } as unknown as Event);
    const selected = component['uploadFile']();
    post.mockReturnValueOnce(throwError(() => new Error('offline')));
    await component['saveSticker']({ emoji: '🍵', name: '茶' });
    expect(component['uploadFile']()).toBe(selected);
    expect(component['editorError']()).toBeTruthy();
    expect(component['pack']()?.stickers).toHaveLength(1);
    await component['saveSticker']({ emoji: '🍵', name: '茶' });
    expect(component['uploadFile']()).toBeUndefined();
    expect(component['pack']()?.stickers).toHaveLength(2);
  });
});
