import test from 'node:test'
import assert from 'node:assert/strict'
import { matchFast } from '../src/main/fast-commands.ts'

test('volume phrases', () => {
  assert.equal(matchFast('Громче!')?.action, 'up')
  assert.equal(matchFast('Джарвис, сделай потише')?.action, 'down')
  assert.equal(matchFast('volume up')?.action, 'up')
  assert.deepEqual(matchFast('громкость 40')?.level, 40)
  assert.equal(matchFast('set volume to thirty')?.level, 30)
  assert.equal(matchFast('выключи звук')?.action, 'mute')
})
test('media and desktop', () => {
  assert.equal(matchFast('пауза')?.kind, 'media')
  assert.equal(matchFast('следующий трек')?.action, 'next')
  assert.equal(matchFast('show desktop')?.action, 'show_desktop')
  assert.equal(matchFast('сверни все окна')?.kind, 'desktop')
})
test('does not hijack real requests', () => {
  assert.equal(matchFast('включи музыку Daft Punk'), null)
  assert.equal(matchFast('какая громкость у этого трека в оригинале и почему так'), null)
  assert.equal(matchFast('open the volume mixer and show me the apps'), null)
  assert.equal(matchFast('назад к предыдущему письму в почте'), null)
})
