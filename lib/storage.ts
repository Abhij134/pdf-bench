/**
 * lib/storage.ts
 * Thin abstraction over local filesystem (dev) and S3 (prod).
 * Switch via STORAGE_DRIVER env var: "local" | "s3"
 *
 * All methods work with storage KEYS (relative paths), not absolute paths.
 * Example key: "documents/abc123/original.pdf"
 */
import fs from 'fs'
import path from 'path'

const DRIVER = process.env.STORAGE_DRIVER ?? 'local'
const LOCAL_ROOT = process.env.LOCAL_STORAGE_PATH ?? './storage'

/**
 * Save a Buffer to storage. Returns the storage key.
 */
export async function saveFile(key: string, data: Buffer): Promise<string> {
  if (DRIVER === 'local') {
    const fullPath = path.join(LOCAL_ROOT, key)
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.promises.writeFile(fullPath, data)
    return key
  }
  // S3 implementation: add when STORAGE_DRIVER=s3
  throw new Error('S3 storage driver not yet implemented. Set STORAGE_DRIVER=local for development.')
}

/**
 * Retrieve a file from storage. Returns a Buffer.
 */
export async function getFile(key: string): Promise<Buffer> {
  if (DRIVER === 'local') {
    const fullPath = path.join(LOCAL_ROOT, key)
    return fs.promises.readFile(fullPath)
  }
  throw new Error('S3 storage driver not yet implemented.')
}

/**
 * Returns the absolute filesystem path for a storage key.
 * Used by Python workers that need a real path.
 * For S3, would instead return a presigned URL or temp file path.
 */
export function resolveLocalPath(key: string): string {
  if (DRIVER === 'local') {
    return path.resolve(path.join(LOCAL_ROOT, key))
  }
  throw new Error('resolveLocalPath is only valid for local storage driver.')
}

/**
 * Delete a file from storage by key.
 * Best-effort: ignores missing file errors.
 */
export async function deleteFile(key: string): Promise<void> {
  if (DRIVER === 'local') {
    const fullPath = path.join(LOCAL_ROOT, key)
    try {
      await fs.promises.unlink(fullPath)
      const parentDir = path.dirname(fullPath)
      const remaining = await fs.promises.readdir(parentDir).catch(() => [])
      if (remaining.length === 0) {
        await fs.promises.rmdir(parentDir).catch(() => {})
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn(`[storage] Could not delete ${fullPath}:`, err.message)
      }
    }
    return
  }
  throw new Error('S3 storage driver not yet implemented.')
}

