import { TestBed } from '@angular/core/testing';
import { ChatAvatar } from './chat-avatar';

describe('ChatAvatar', () => {
  it('renders full emoji for both the chat and topic badge, and updates when the name changes', async () => {
    const fixture = TestBed.createComponent(ChatAvatar);
    fixture.componentRef.setInput('entry', { title: '🕊️ 7版鸽舍 🕊️', badgeName: '👩🏽‍💻小茶' });
    await fixture.whenStable();
    const avatar = () => fixture.nativeElement.querySelector('ion-avatar').textContent.trim();
    const badge = () => fixture.nativeElement.querySelector('.avatar-badge').textContent.trim();
    expect(avatar()).toBe('🕊️');
    expect(badge()).toBe('👩🏽‍💻');
    fixture.componentRef.setInput('entry', { title: '话题', avatarName: '🇨🇳聊天', badgeName: '𠮷野' });
    await fixture.whenStable();
    expect(avatar()).toBe('🇨🇳');
    expect(badge()).toBe('𠮷');
  });
  it('uses deterministic light and dark placeholder colors, preserving icon backgrounds', () => {
    const fixture = TestBed.createComponent(ChatAvatar);
    fixture.componentRef.setInput('entry', { title: 'Alice' });
    fixture.detectChanges();
    const avatar = fixture.nativeElement.querySelector('ion-avatar') as HTMLElement;
    const light = avatar.style.getPropertyValue('--avatar-light');
    const dark = avatar.style.getPropertyValue('--avatar-dark');
    expect(light).toMatch(/^#[0-9A-F]+$/);
    expect(dark).not.toBe(light);
    fixture.componentRef.setInput('entry', { title: 'Bob' });
    fixture.detectChanges();
    expect(avatar.style.getPropertyValue('--avatar-light')).not.toBe(light);
    fixture.componentRef.setInput('entry', { title: 'Alice' });
    fixture.detectChanges();
    expect(avatar.style.getPropertyValue('--avatar-light')).toBe(light);
    fixture.componentRef.setInput('entry', { icon: 'icon' });
    fixture.detectChanges();
    expect(avatar.style.background).toBe('');
  });

  it('keeps loaded images when entry fields change without changing their URLs', () => {
    const fixture = TestBed.createComponent(ChatAvatar);
    const entry = { avatarName: 'Alice', avatar: '/avatar.png', badgeName: 'Bob', badgeAvatar: '/badge.png' };
    fixture.componentRef.setInput('entry', entry);
    fixture.detectChanges();
    const images = Array.from(fixture.nativeElement.querySelectorAll('img')) as HTMLImageElement[];
    for (const image of images) image.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    fixture.componentRef.setInput('entry', { ...entry, avatarName: 'Updated', badgeName: 'Changed' });
    fixture.detectChanges();
    expect(Array.from(fixture.nativeElement.querySelectorAll('img'))).toEqual(images);
    for (const image of images) expect(image.classList.contains('loaded')).toBe(true);

    fixture.componentRef.setInput('entry', { ...entry, avatar: '/replacement.png' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img').classList.contains('loaded')).toBe(false);
    expect(images[1].classList.contains('loaded')).toBe(true);
    fixture.componentRef.setInput('entry', { ...entry, avatar: '/replacement.png', badgeAvatar: '/new-badge.png' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.avatar-badge img').classList.contains('loaded')).toBe(false);
  });

  it('retains the placeholder on failure and ignores a previous URL load after replacement', () => {
    const fixture = TestBed.createComponent(ChatAvatar);
    fixture.componentRef.setInput('entry', {
      avatarName: 'Alice',
      avatar: '/one.png',
      badgeName: 'Bob',
      badgeAvatar: '/badge.png',
    });
    fixture.detectChanges();
    const avatar = fixture.nativeElement.querySelector('ion-avatar') as HTMLElement;
    const previous = avatar.querySelector('img')!;
    previous.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(avatar.classList.contains('placeholder')).toBe(true);
    expect(previous.classList.contains('loaded')).toBe(false);
    fixture.componentRef.setInput('entry', {
      avatarName: 'Alice',
      avatar: '/two.png',
      badgeName: 'Bob',
      badgeAvatar: '/badge.png',
    });
    fixture.detectChanges();
    const current = avatar.querySelector('img')!;
    expect(current).not.toBe(previous);
    previous.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(current.classList.contains('loaded')).toBe(false);
    current.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(current.classList.contains('loaded')).toBe(true);
    expect(avatar.classList.contains('placeholder')).toBe(false);
    const badge = fixture.nativeElement.querySelector('.avatar-badge') as HTMLElement;
    expect(badge.classList.contains('placeholder')).toBe(true);
    badge.querySelector('img')!.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(badge.classList.contains('placeholder')).toBe(false);
  });
});
