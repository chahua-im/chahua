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
});
