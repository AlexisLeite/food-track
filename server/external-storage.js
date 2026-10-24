import { mkdir, open, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export const storagePath = (handle, ...parts) => join('/proc', String(process.pid), 'fd', String(handle.fd), ...parts);

// Opening and checking the mount before creating subdirectories prevents writes
// into an empty mountpoint on the internal disk. The fd anchors subsequent I/O
// to that same volume even if a later unmount changes the visible pathname.
export async function openExternalDirectory(settings) {
  let volume;
  try {
    let destination = settings.directory;
    if (settings.mountPoint || settings.mountUuid) {
      if (!settings.mountPoint || !settings.mountUuid || !isAbsolute(destination)) throw new Error('Invalid external volume configuration');
      const subpath = relative(settings.mountPoint, destination);
      if (subpath === '..' || subpath.startsWith('..' + sep) || isAbsolute(subpath)) throw new Error('Destination is outside configured volume');
      volume = await open(settings.mountPoint, 'r');
      const [mounted, device] = await Promise.all([volume.stat(), stat('/dev/disk/by-uuid/' + settings.mountUuid)]);
      if (!device.isBlockDevice() || mounted.dev !== device.rdev) return null;
      destination = storagePath(volume, subpath);
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    return await open(destination, 'r');
  } catch (error) {
    if (['ENOENT', 'ENODEV', 'ENXIO'].includes(error.code)) return null;
    throw error;
  } finally { await volume?.close(); }
}
