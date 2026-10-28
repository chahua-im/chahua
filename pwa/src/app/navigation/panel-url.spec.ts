import { DefaultUrlSerializer } from '@angular/router';
import { panelDefinitions } from './panel-definitions';
import { panelPaths, PanelUrlSerializer, setPanelPaths } from './panel-url';

describe('Readable panel URLs', () => {
  const serializer = new PanelUrlSerializer();
  const base = '/chats/chat/100';
  const settings = ['/settings', '/settings/privacy', '/settings/blocked-users'];

  it.each([
    [['/settings'], 'settings'],
    [['/settings', '/settings/privacy'], 'settings=privacy'],
    [[...settings, '/profile/2'], 'settings=privacy/blocked-users&profile=2'],
    [['/profile/2', '/settings/privacy'], 'profile=2&settings=~privacy'],
    [['/settings', '/settings/blocked-users'], 'settings=~settings~blocked-users'],
    [['/settings/privacy', '/settings/blocked-users'], 'settings=~privacy/blocked-users'],
    [['/settings', '/settings/notifications', '/settings/notifications/dm'], 'settings=notifications/dm'],
    [['/profile/2', '/settings/notifications/dm'], 'profile=2&settings=~notification/dm'],
    [['/settings', '/settings/stickers', '/settings/stickers/123'], 'settings=stickers/123'],
    [['/settings/stickers/123'], 'settings=~sticker-pack/123'],
    [['/chats/chat/100/info'], 'info'],
    [['/chats/chat/100/info?view=image'], 'info=images'],
    [['/chats/chat/100/info?view=3'], 'info=management'],
    [['/profile/2?view=2'], 'profile=2/privacy'],
    [['/chats/chat/200/info'], 'info=chats/chat/200/info'],
    [['/chats/chat/100/thread/300/info?view=3'], 'info=thread/300/info/management'],
    [['/stickers/123'], 'stickers=123'],
    [['/chats/chat/100/stickers/123'], 'stickers=chats/chat/100/stickers/123'],
    [['/chats/chat/100/message/200/reactions'], 'reactions=200'],
    [['/chats/new'], 'create'],
    [['/chats/add-friend'], 'add-friend'],
    [['/chats/join/abc'], 'join=abc'],
    [['/media'], 'media'],
    [['/chats/chat/100/search'], 'search'],
    [['/chats/chat/100/invites'], 'invites'],
  ] as [string[], string][])('encodes %j using named parameters: %s', (paths, address) => {
    const tree = serializer.parse(base);
    setPanelPaths(tree, paths);
    const url = serializer.serialize(tree);
    expect(url).toBe(`${base}?${address}`);
    expect(panelPaths(serializer.parse(url))).toEqual(paths);
  });

  it.each(panelDefinitions)('round-trips $path on list, chat and thread sources', (definition) => {
    const id = '9007199254740993';
    const path = '/' + definition.path.replace(/:\w+/g, id);
    for (const source of ['/chats', `/chats/chat/${id}`, `/chats/chat/${id}/thread/${id}`]) {
      const tree = serializer.parse(source);
      setPanelPaths(tree, [path]);
      expect(panelPaths(serializer.parse(serializer.serialize(tree)))).toEqual([path]);
    }
  });

  it.each(['a$&b', 'a$$b', 'a%2Fb%3Fc%26d', 'a~b'])('preserves invitation code %s', (code) => {
    const tree = serializer.parse(base);
    setPanelPaths(tree, ['/chats/join/' + code]);
    expect(tree.queryParams['join']).toBe(code);
    expect(panelPaths(serializer.parse(serializer.serialize(tree)))).toEqual(['/chats/join/' + code]);
  });

  it('uses the thread as the scope without losing large IDs', () => {
    const tree = serializer.parse('/chats/chat/9007199254740993/thread/9007199254740995');
    const paths = ['/chats/chat/9007199254740993/thread/9007199254740995/info?view=other'];
    setPanelPaths(tree, paths);
    expect(serializer.serialize(tree)).toBe('/chats/chat/9007199254740993/thread/9007199254740995?info=files');
    expect(panelPaths(serializer.parse(serializer.serialize(tree)))).toEqual(paths);
  });

  it('normalizes old repeated parameters without changing other query data or the message anchor', () => {
    const tree = serializer.parse(
      `${base}?q=a%26b%2Fc&panel=%2Fsettings&panel=%2Fsettings%2Fprivacy&panel=%2Fsettings%2Fblocked-users&panel=%2Fprofile%2F2#msg=200`,
    );
    expect(serializer.serialize(tree)).toBe(`${base}?q=a%26b%2Fc&settings=privacy/blocked-users&profile=2#msg=200`);
    expect(panelPaths(tree)).toEqual([...settings, '/profile/2']);
    expect(tree.queryParams['q']).toBe('a&b/c');
  });

  it('keeps a literal chain separator inside an invite code as data', () => {
    const tree = serializer.parse(base);
    const paths = ['/chats/join/a~b%2Fc%26d', '/profile/2'];
    setPanelPaths(tree, paths);
    expect(tree.queryParams['join']).toBe('a~b%2Fc%26d');
    expect(tree.queryParams['profile']).toBe('2');
    expect(panelPaths(serializer.parse(serializer.serialize(tree)))).toEqual(paths);
  });

  it('does not treat query-looking fragment text as a panel parameter', () => {
    const original = `${base}?q=a%2Fb#?panel=a%2Fb`;
    expect(serializer.serialize(serializer.parse(original))).toBe(
      new DefaultUrlSerializer().serialize(new DefaultUrlSerializer().parse(original)),
    );
  });

  it('replaces an earlier kind and moves the new object above the remaining source', () => {
    const tree = serializer.parse(base);
    setPanelPaths(tree, ['/profile/2', ...settings, '/profile/3']);
    expect(serializer.serialize(tree)).toBe(`${base}?settings=privacy/blocked-users&profile=3`);
    expect(panelPaths(tree)).toEqual([...settings, '/profile/3']);
  });

  it('uses the actual last position of repeated query keys, including mixed legacy input', () => {
    const tree = serializer.parse(`${base}?profile=2&settings=privacy&profile=3`);
    expect(serializer.serialize(tree)).toBe(`${base}?settings=privacy&profile=3`);
    expect(panelPaths(tree)).toEqual(['/settings', '/settings/privacy', '/profile/3']);
    const legacy = serializer.parse(`${base}?panel=profile/2~settings/privacy~profile/3`);
    expect(serializer.serialize(legacy)).toBe(serializer.serialize(tree));
    const mixed = serializer.parse(`${base}?profile=2&panel=settings/privacy&profile=3`);
    expect(serializer.serialize(mixed)).toBe(serializer.serialize(tree));
  });

  it('replaces a settings branch while retaining actual ancestors and unrelated panels', () => {
    const tree = serializer.parse(base);
    setPanelPaths(tree, [...settings, '/profile/2', '/settings/general']);
    expect(serializer.serialize(tree)).toBe(`${base}?profile=2&settings=general`);
    expect(panelPaths(tree)).toEqual(['/profile/2', '/settings', '/settings/general']);
  });

  it('treats the order of distinct named parameters as the visible panel order', () => {
    expect(panelPaths(serializer.parse(`${base}?settings=privacy&profile=2`)).at(-1)).toBe('/profile/2');
    expect(panelPaths(serializer.parse(`${base}?profile=2&settings=privacy`)).at(-1)).toBe('/settings/privacy');
  });

  it('does not modify unrelated parameters or a query-looking fragment', () => {
    const original = `${base}?q=a%2Fb&tag=x&tag=y&profile=2#?settings=a%2Fb`;
    const standard = new DefaultUrlSerializer();
    expect(serializer.serialize(serializer.parse(original))).toBe(standard.serialize(standard.parse(original)));
  });
});
