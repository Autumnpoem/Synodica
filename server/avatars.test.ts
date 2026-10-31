import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { AVATAR_LIMITS, avatarUrl, inspectImage, parseAvatarRef } from '../shared/avatar.js'
import { AvatarError, AvatarStore } from './avatars.js'
import { parseTeam } from './team.js'
import { mixedTeam, tmp } from './testkit.js'

function png(w: number, h: number, extra = 64): Buffer {
  const b = Buffer.alloc(33 + extra)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}
function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)])
}
function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(32)
  b.write('GIF89a', 0, 'ascii')
  b.writeUInt16LE(w, 6)
  b.writeUInt16LE(h, 8)
  return b
}

test('inspectImage accepts PNG, JPEG and GIF by their real header bytes and reads geometry', () => {
  assert.deepEqual(inspectImage(png(256, 128)), { ok: true, format: 'png', width: 256, height: 128 })
  assert.deepEqual(inspectImage(jpeg(640, 480)), { ok: true, format: 'jpeg', width: 640, height: 480 })
  assert.deepEqual(inspectImage(gif(64, 64)), { ok: true, format: 'gif', width: 64, height: 64 })
})

test('inspectImage refuses SVG, HTML, renamed text, empty, oversized and out-of-range geometry', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>')
  assert.equal(inspectImage(svg).ok, false)
  assert.match((inspectImage(svg) as { error: string }).error, /SVG/)
  assert.equal(inspectImage(Buffer.from('<!doctype html><script>alert(1)</script>')).ok, false)
  assert.equal(inspectImage(Buffer.from('PNG but not really')).ok, false)
  assert.equal(inspectImage(Buffer.alloc(0)).ok, false)
  assert.equal(inspectImage(png(64, 64, AVATAR_LIMITS.maxBytes)).ok, false, 'larger than the byte limit')
  assert.equal(inspectImage(png(8, 8)).ok, false, 'too small')
  assert.equal(inspectImage(png(5000, 100)).ok, false, 'side too large')
  assert.equal(inspectImage(png(4096, 4096)).ok, true)
  assert.equal(inspectImage(gif(4096, 4096)).ok, true)
})

test('avatar references only keep generated ids; paths and URLs fall back to color and shape', () => {
  assert.equal(parseAvatarRef({ id: '../../etc/passwd' }), undefined)
  assert.equal(parseAvatarRef({ id: 'https://tracker.example/pixel.png' }), undefined)
  assert.equal(parseAvatarRef({ id: 'av-0123456789abcdef01234567.png' }), undefined)
  assert.deepEqual(parseAvatarRef({ id: 'av-0123456789abcdef01234567', fit: 'weird', updatedAt: 5 }), { id: 'av-0123456789abcdef01234567', fit: 'cover', updatedAt: 5 })
  assert.equal(avatarUrl({ id: 'av-0123456789abcdef01234567', fit: 'contain', updatedAt: 9 }), '/api/avatars/av-0123456789abcdef01234567?v=9')
})

test('upload, replace and reset persist through the team file; old files are removed; existing teams migrate untouched', () => {
  const dir = tmp()
  const avatars = new AvatarStore(dir)
  const base = mixedTeam(tmp('ogb-ws-'))
  // An existing team without avatars parses unchanged (color and shape stay).
  const parsed = parseTeam(JSON.parse(JSON.stringify(base)), base.workspace)
  assert.equal(parsed.agents[0]?.avatar, undefined)
  assert.equal(parsed.agents[0]?.color, '#888')

  const first = avatars.assign(parsed, 'lead', png(128, 128), 'contain')
  first.commit()
  const t1 = parseTeam(JSON.parse(JSON.stringify(first.team)), base.workspace)
  const ref1 = t1.agents.find((a) => a.id === 'lead')?.avatar
  assert.ok(ref1, 'the avatar survives a save and reload of the team file')
  assert.equal(ref1.fit, 'contain')
  assert.equal(t1.agents.find((a) => a.id === 'lead')?.shape, 'blob', 'the fallback shape is kept')
  assert.equal(avatars.find(ref1.id)?.mime, 'image/png')

  const second = avatars.assign(t1, 'lead', jpeg(200, 100), undefined)
  second.commit()
  const ref2 = second.team.agents.find((a) => a.id === 'lead')?.avatar
  assert.ok(ref2 && ref2.id !== ref1.id)
  assert.equal(avatars.find(ref1.id), undefined, 'the replaced file is deleted')
  assert.equal(avatars.find(ref2.id)?.mime, 'image/jpeg')

  const owner = avatars.assign(second.team, 'user', gif(48, 48), 'cover')
  owner.commit()
  assert.ok(owner.team.owner.avatar)

  const reset = avatars.assign(owner.team, 'lead', undefined, undefined)
  reset.commit()
  assert.equal(reset.team.agents.find((a) => a.id === 'lead')?.avatar, undefined, 'reset returns to color and shape')
  assert.equal(avatars.find(ref2.id), undefined)
  assert.deepEqual(avatars.ids(), [owner.team.owner.avatar?.id])
})

test('the avatar store rejects bad uploads, unknown targets and anything but its own validated files', () => {
  const dir = tmp()
  const avatars = new AvatarStore(dir)
  const team = mixedTeam(tmp('ogb-ws-'))
  assert.throws(() => avatars.assign(team, 'lead', Buffer.from('<svg/>'), 'cover'), AvatarError)
  assert.throws(() => avatars.assign(team, 'nobody', png(64, 64), 'cover'), (e: unknown) => e instanceof AvatarError && e.status === 404)
  assert.deepEqual(avatars.ids(), [], 'nothing is stored for a refused upload')
  assert.equal(avatars.find('../team.json'), undefined)
  assert.equal(avatars.find('av-0123456789abcdef01234567/../../x'), undefined)
  // A file put into the folder by hand under a valid id, but not a real image, is never served.
  writeFileSync(path.join(avatars.dir, 'av-aaaaaaaaaaaaaaaaaaaaaaaa.png'), '<html>not an image</html>')
  assert.equal(avatars.find('av-aaaaaaaaaaaaaaaaaaaaaaaa'), undefined)
  assert.ok(existsSync(path.join(avatars.dir, 'av-aaaaaaaaaaaaaaaaaaaaaaaa.png')), 'and nothing unrelated is deleted')
})
