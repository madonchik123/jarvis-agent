// Hidden "audio host" page: microphone capture → main (speech engine), and TTS playback with the Jarvis polish chain.
import { api, IPC } from './api'
import type { Settings } from '@shared/types'

let settings: Settings | null = null
let micCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let currentMic = ''

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(800); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) {
        let s = 0
        for (let j = 0; j < this.n; j++) s += this.buf[j] * this.buf[j]
        this.port.postMessage({ pcm: this.buf.slice(0), rms: Math.sqrt(s / this.n) })
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('capture', Capture)
`

async function startMic() {
  stopMic()
  const id = settings?.micDeviceId ?? 'default'
  currentMic = id
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id === 'default' ? undefined : { exact: id },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    micCtx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    await micCtx.audioWorklet.addModule(url)
    const src = micCtx.createMediaStreamSource(micStream)
    const node = new AudioWorkletNode(micCtx, 'capture')
    node.port.onmessage = (e) => {
      const { pcm, rms } = e.data as { pcm: Float32Array; rms: number }
      api.send(IPC.audioChunk, pcm.buffer)
      api.send(IPC.micLevel, Math.min(1, rms * 7))
    }
    src.connect(node)
    // keep the graph alive without audible output
    const mute = micCtx.createGain()
    mute.gain.value = 0
    node.connect(mute).connect(micCtx.destination)
  } catch (e) {
    console.error('mic failed', e)
    setTimeout(startMic, 4000)
  }
}

function stopMic() {
  micStream?.getTracks().forEach((t) => t.stop())
  void micCtx?.close()
  micStream = null
  micCtx = null
}

// ------------------------------------------------------------------ playback
let outCtx: AudioContext | null = null
let current: { src: AudioBufferSourceNode; id: string } | null = null
let analyser: AnalyserNode | null = null
let levelTimer: number | null = null

function ensureOut() {
  if (!outCtx) {
    outCtx = new AudioContext()
    analyser = outCtx.createAnalyser()
    analyser.fftSize = 512
    analyser.connect(outCtx.destination)
  }
  return outCtx
}

function jarvisChain(ctx: AudioContext, fx: boolean, volume: number): { input: AudioNode } {
  const gain = ctx.createGain()
  gain.gain.value = volume
  gain.connect(analyser!)
  if (!fx) return { input: gain }
  // gentle "digital butler" polish: presence lift, air, short metallic comb, soft limiter
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 80
  const presence = ctx.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 2400
  presence.Q.value = 0.9
  presence.gain.value = 3.5
  const air = ctx.createBiquadFilter()
  air.type = 'highshelf'
  air.frequency.value = 7000
  air.gain.value = 2.5
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -18
  comp.ratio.value = 3
  const delay = ctx.createDelay(0.05)
  delay.delayTime.value = 0.011
  const fb = ctx.createGain()
  fb.gain.value = 0.22
  const wet = ctx.createGain()
  wet.gain.value = 0.28
  hp.connect(presence).connect(air).connect(comp)
  comp.connect(gain)
  comp.connect(delay)
  delay.connect(fb).connect(delay)
  delay.connect(wet).connect(gain)
  return { input: hp }
}

function startLevels() {
  if (levelTimer) return
  const data = new Uint8Array(analyser!.fftSize)
  levelTimer = window.setInterval(() => {
    analyser!.getByteTimeDomainData(data)
    let s = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      s += v * v
    }
    api.send(IPC.ttsLevel, Math.min(1, Math.sqrt(s / data.length) * 4.5))
  }, 33)
}
function stopLevels() {
  if (levelTimer) clearInterval(levelTimer)
  levelTimer = null
  api.send(IPC.ttsLevel, 0)
}

async function play(req: { id: string; wav: Uint8Array; fx: boolean; volume: number }) {
  const ctx = ensureOut()
  if (ctx.state === 'suspended') await ctx.resume()
  try {
    const ab = req.wav.buffer.slice(req.wav.byteOffset, req.wav.byteOffset + req.wav.byteLength) as ArrayBuffer
    const buf = await ctx.decodeAudioData(ab)
    const src = ctx.createBufferSource()
    src.buffer = buf
    const chain = jarvisChain(ctx, req.fx, req.volume)
    src.connect(chain.input)
    current = { src, id: req.id }
    src.onended = () => {
      if (current?.id === req.id) current = null
      stopLevels()
      api.send(IPC.ttsEnded, req.id)
    }
    startLevels()
    src.start()
  } catch (e) {
    console.error('playback failed', e)
    api.send(IPC.ttsEnded, req.id)
  }
}

function earcon(kind = 'wake') {
  if (settings && !settings.wakeSound) return
  const ctx = ensureOut()
  const t = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'sine'
  const [f0, f1] = kind === 'sleep' ? [900, 420] : [620, 1240]
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.11)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  o.connect(g).connect(ctx.destination)
  o.start(t)
  o.stop(t + 0.22)
}

async function main() {
  settings = await api.invoke(IPC.settingsGet)
  api.on(IPC.settingsChanged, (s: Settings) => {
    const changed = s.micDeviceId !== currentMic
    settings = s
    if (changed) void startMic()
  })
  api.on(IPC.ttsPlay, (req: any) => void play(req))
  api.on(IPC.ttsStop, () => {
    try {
      current?.src.stop()
    } catch {}
  })
  api.on('audio:earcon', (k: string) => earcon(k))
  await startMic()
}

void main()
