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
});
