import { describe, expect, it } from 'vitest'
import { parseSafeExternalHttpsUrl, readResponseBodyLimited } from '../src/lib/external-url'
import { buildAttachmentHeaders } from '../src/routes/attachments'
import { detectSafeImageMime } from '../src/lib/image-mime'

describe('external URL safety', () => {
  it('accepts public HTTPS and rejects local/private/special targets', () => {
    expect(parseSafeExternalHttpsUrl('https://api.example.com/v1').hostname).toBe('api.example.com')
    for (const url of [
      'http://api.example.com/v1',
      'https://localhost/x',
      'https://127.0.0.2/x',
      'https://10.0.0.1/x',
      'https://100.64.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://172.16.0.1/x',
      'https://192.168.1.1/x',
      'https://198.18.0.1/x',
      'https://[::1]/x',
      'https://[fc00::1]/x',
      'https://[fe80::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://metadata.internal/x',
      'https://user:pass@example.com/x',
    ]) {
      expect(() => parseSafeExternalHttpsUrl(url), url).toThrow()
    }
  })

  it('caps streamed remote bodies even without content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6))
        controller.enqueue(new Uint8Array(6))
        controller.close()
      },
    })
    await expect(readResponseBodyLimited(new Response(stream), 10)).rejects.toThrow(/too large/)
  })
})

describe('attachment response hardening', () => {
  it('allows safe raster images inline but forces active content to download', () => {
    const image = new Headers(buildAttachmentHeaders('image/png', 'receipt.png', 10))
    expect(image.get('content-disposition')).toMatch(/^inline;/)
    expect(image.get('cache-control')).toMatch(/^private/)
    expect(image.get('x-content-type-options')).toBe('nosniff')

    const html = new Headers(buildAttachmentHeaders('text/html', 'evil.html', 20))
    expect(html.get('content-disposition')).toMatch(/^attachment;/)
    expect(html.get('content-security-policy')).toContain('sandbox')
  })
})

describe('image magic detection', () => {
  it('recognizes PNG/JPEG/WebP and rejects HTML disguised as an image', () => {
    expect(detectSafeImageMime(Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))).toBe('image/png')
    expect(detectSafeImageMime(Uint8Array.from([0xff,0xd8,0xff,0x00]))).toBe('image/jpeg')
    expect(detectSafeImageMime(Uint8Array.from([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50]))).toBe('image/webp')
    expect(detectSafeImageMime(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull()
  })
})
