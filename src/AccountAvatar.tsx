import { useRef, useState } from 'react';
import { useLanguage } from './i18n';
import Button from './ui/Button';

export function accountInitial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() || 'M';
}

export function AccountAvatar({ name, source, className = 'account-profile-avatar' }: { name: string; source?: string; className?: string }) {
  const [failed, setFailed] = useState<string>();
  return <span className={className} aria-hidden="true">
    {source && source !== failed
      ? <img src={source} alt="" referrerPolicy="no-referrer" onError={() => setFailed(source)} />
      : accountInitial(name)}
  </span>;
}

async function resizeAvatar(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw Error('invalid image');
  const image = await createImageBitmap(file);
  try {
    const size = Math.min(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw Error('image rendering unavailable');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 128, 128);
    context.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 128, 128);
    return canvas.toDataURL('image/jpeg', 0.86);
  } finally {
    image.close();
  }
}

export function AvatarEditor({ name, providerUrl, custom, save }: { name: string; providerUrl?: string; custom?: string; save: (value: string | null) => void | Promise<void> }) {
  const { text: l } = useLanguage();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = async (file: File | null) => {
    setBusy(true);
    setError('');
    try {
      await save(file ? await resizeAvatar(file) : null);
    } catch {
      setError(l('头像保存失败。请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片。', 'Could not save the avatar. Choose a JPG, PNG or WebP image up to 5 MB.'));
    } finally {
      setBusy(false);
    }
  };
  return <div className="account-avatar-editor">
    <div className="account-avatar-row">
      <AccountAvatar name={name} source={custom || providerUrl} />
      <div className="personal-actions">
        <Button disabled={busy} onClick={() => input.current?.click()}>{l('更换头像', 'Change avatar')}</Button>
        {custom && <Button disabled={busy} onClick={() => void update(null)}>{l('恢复默认头像', 'Reset avatar')}</Button>}
        <input hidden ref={input} type="file" accept="image/jpeg,image/png,image/webp" aria-label={l('选择头像图片', 'Choose an avatar image')} onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void update(file);
        }} />
      </div>
    </div>
    <p className="personal-caption">{l('替换的头像仅保存在当前设备。', 'Custom avatars are stored on this device.')}</p>
    {error && <p role="alert" className="personal-error">{error}</p>}
  </div>;
}
